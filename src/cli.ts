import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, isAbsolute, sep } from "node:path";
import { crewBrief, crewState, crewTable, firstMateBrief, parseStatus } from "./brief.ts";
import type { Config } from "./config.ts";
import { loadConfig, resolveModel } from "./config.ts";
import { daemonPid, runDaemon, tick } from "./daemon.ts";
import { forkPoint, localHead, originHead, resolveSpawnBase } from "./git.ts";
import { DAEMON_LOG, daemonInstall, daemonRestart, daemonUninstall, doctor, install, uninstall } from "./install.ts";
import { stopWorktreeProcesses } from "./procs.ts";
import { currentBranch, resolveProject } from "./project.ts";
import type { CrewMember, ProjectState } from "./state.ts";
import { broadcastTargets, emptyState, findCrew, readState, withState } from "./state.ts";
import type { Project, Shell, ShellThread } from "./t3.ts";
import {
  archiveThread,
  getShell,
  getThread,
  hasLiveSession,
  interruptThread,
  isBusy,
  lastAssistantText,
  sendMessage,
  startThread,
  stopSession,
} from "./t3.ts";
import { UserError, fail, nowIso, oneLine, plural, readStdin, run, sleep, tail } from "./util.ts";

const HELP = `t3mate — a first mate for T3 Code

Captain (you): send "$t3mate <request>" in any T3 thread, in any project, on any harness.
First mate (that thread) uses:
  claim --nonce <random>             make the calling thread this project's first mate
  brief                              playbook + live crew/backlog for this project
  spawn [opts] -- "<task>"           dispatch a crewmate (task may also come via stdin / --file)
      --scout                          deliverable is a report, not a code change
      --title <t>  --model <spec|alias>  --base <branch>  --here (no worktree)
  list [--all]                       crew status
  peek <n> [--full]                  state, branch, PRs, last reply
  diff <n> [--stat]                  crewmate's changes vs its base
  send <n> "<message>"               follow up with / steer a crewmate
  broadcast [opts] "<message>"       send to every active crewmate (running or idle)
      --running  only running ones    --except 3,5  skip some    --dry-run  just list who'd get it
  stop <n>                           interrupt a crewmate's running turn
  archive <n>... [--keep-processes]  retire crewmates: archive their T3 threads, stop their
                                     sessions and any processes still running from their worktrees
      <n> is the crew number (3 or #3) or the crewmate's T3 thread id
  backlog add "<text>" | list | done <n> | rm <n>

Setup:
  install [--rotate-token] [--no-daemon]   install CLI + skills, T3 token, daemon
  uninstall                                undo install (keeps ~/.t3mate)
  doctor                                   check everything
  daemon run|tick|install|uninstall|restart|status|logs
  config                                   show the effective config for this project
`;

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["nonce", "thread", "title", "model", "base", "file", "runtime-mode", "except"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[name] = inline;
      else if (VALUE_FLAGS.has(name)) {
        const value = argv[++i];
        if (value === undefined) fail(`--${name} needs a value`);
        flags[name] = value;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

interface Ctx {
  shell: Shell;
  project: Project;
  config: Config;
  init: () => ProjectState;
  state: ProjectState;
  thread: (id: string) => ShellThread | undefined;
}

async function context(): Promise<Ctx> {
  const shell = await getShell();
  const project = resolveProject(shell);
  const init = () => emptyState(project.id, project.workspaceRoot, project.title);
  return {
    shell,
    project,
    config: loadConfig(project.workspaceRoot),
    init,
    state: readState(project.id) ?? init(),
    thread: (id) => shell.threads.find((t) => t.id === id),
  };
}

function crewOrFail(state: ProjectState, ref: string | undefined): CrewMember {
  if (!ref) fail("Which crewmate? Pass its number, e.g. `3` or `#3`, or its T3 thread id.");
  return findCrew(state, ref) ?? fail(`No crewmate ${ref} in ${state.title}. Pass its number or its full T3 thread id; see \`t3mate list --all\`.`);
}

async function taskText(args: Args, from: number): Promise<string> {
  const file = str(args.flags.file);
  const text = file ? readFileSync(file, "utf8") : args.positional.slice(from).join(" ") || ((await readStdin()) ?? "");
  if (!text.trim()) fail("No text given (pass it as an argument, via --file, or on stdin).");
  return text;
}

// ---------------------------------------------------------------- commands

/** Find the thread whose in-flight tool call contains the nonce the agent just invented. */
async function findClaimingThread(projectId: string, nonce: string): Promise<ShellThread> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const shell = await getShell();
    const busy = shell.threads.filter((t) => t.projectId === projectId && !t.archivedAt && isBusy(t));
    for (const t of busy) {
      const detail = await getThread(t.id);
      const recent = detail.activities.slice(-40);
      if (recent.some((a) => JSON.stringify(a.payload).includes(nonce))) return t;
    }
    await sleep(750);
  }
  fail(
    "Couldn't identify the calling thread from its nonce. Make sure you run `t3mate claim --nonce <nonce>` from inside the T3 thread that should become the first mate, with a fresh random nonce.",
  );
}

async function cmdClaim(args: Args): Promise<void> {
  const ctx = await context();
  let thread: ShellThread | undefined;
  const explicit = str(args.flags.thread);
  if (explicit) {
    thread = ctx.thread(explicit) ?? fail(`No T3 thread ${explicit}.`);
  } else {
    const nonce = str(args.flags.nonce);
    if (!nonce || nonce.length < 6 || nonce === "NONCE") fail("Pass --nonce <at least 6 random characters you just made up>.");
    thread = await findClaimingThread(ctx.project.id, nonce);
  }
  if (thread.projectId !== ctx.project.id) fail(`Thread ${thread.id} belongs to a different T3 project.`);
  const previous = await withState(ctx.project.id, ctx.init, (s) => {
    const prev = s.firstMate?.threadId;
    s.firstMate = {
      threadId: thread.id,
      claimedAt: nowIso(),
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
    };
    return prev;
  });
  const notes = [`Claimed: thread ${thread.id} is now the first mate for "${ctx.project.title}".`];
  if (previous && previous !== thread.id) notes.push(`(It replaces the previous first mate thread ${previous}; crew updates now come here.)`);
  if (!daemonPid()) notes.push("WARNING: the t3mate daemon isn't running, so crew updates won't arrive. Tell the captain to run `t3mate doctor`.");
  console.log(`${notes.join("\n")}\n\n${firstMateBrief(readState(ctx.project.id)!, ctx.shell, ctx.config)}`);
}

async function cmdBrief(): Promise<void> {
  const ctx = await context();
  console.log(firstMateBrief(ctx.state, ctx.shell, ctx.config));
}

async function cmdSpawn(args: Args): Promise<void> {
  const ctx = await context();
  const task = await taskText(args, 0);
  const fmId = ctx.state.firstMate?.threadId;
  const fm = fmId ? ctx.thread(fmId) : undefined;
  if (!fm) fail("This project has no first mate. Send `$t3mate` in a T3 thread first.");

  const kind = args.flags.scout ? "scout" : "ship";
  const modelSpec = str(args.flags.model) ?? ctx.config.crew.model ?? "inherit";
  const modelSelection = resolveModel(modelSpec, ctx.config, fm.modelSelection);
  const runtimeMode = (str(args.flags["runtime-mode"]) ?? ctx.config.crew.runtime_mode ?? fm.runtimeMode) as ShellThread["runtimeMode"];
  const baseBranch = str(args.flags.base) ?? ctx.config.crew.base_branch ?? currentBranch(ctx.project.workspaceRoot);
  let worktree = ctx.config.crew.worktree && !args.flags.here;
  if (worktree && !baseBranch) {
    console.error("note: project is not a git repo (or HEAD is detached); crewmate will work in the main checkout.");
    worktree = false;
  }
  const title = str(args.flags.title) ?? oneLine(task.split("\n").find((l) => l.trim()) ?? task, 60);
  const root = ctx.project.workspaceRoot;
  const start = worktree && baseBranch ? resolveSpawnBase(root, baseBranch, ctx.config.crew.start_from_origin) : { fromOrigin: false };
  if (start.note) console.error(start.note);

  const n = await withState(ctx.project.id, ctx.init, (s) => s.nextCrew++);
  const threadId = await startThread({
    projectId: ctx.project.id,
    projectRoot: ctx.project.workspaceRoot,
    title,
    text: crewBrief({ n, kind, task, worktree, config: ctx.config }),
    modelSelection,
    runtimeMode,
    interactionMode: ctx.config.crew.interaction_mode,
    baseBranch,
    worktree,
    startFromOrigin: start.fromOrigin,
    runSetupScript: ctx.config.crew.run_setup_script,
  });
  // What the worktree started from, so the daemon can tell when origin/<base> moves past it.
  const baseSha = worktree && baseBranch ? ((start.fromOrigin ? originHead(root, baseBranch) : localHead(root, baseBranch)) ?? undefined) : undefined;
  await withState(ctx.project.id, ctx.init, (s) => {
    s.crew.push({
      n,
      threadId,
      title,
      kind,
      task,
      baseBranch,
      model: `${modelSelection.instanceId}:${modelSelection.model}`,
      createdAt: nowIso(),
      status: "active",
      watch: baseSha ? { baseSha } : {},
    });
  });
  console.log(
    `Spawned #${n} (${kind}) "${title}" → T3 thread ${threadId}\n` +
      `  model ${modelSelection.instanceId}:${modelSelection.model}, ${runtimeMode}, ` +
      (worktree ? `new T3 worktree from ${start.fromOrigin ? `origin/${baseBranch}` : baseBranch}` : "main checkout"),
  );
}

async function cmdList(args: Args): Promise<void> {
  const ctx = await context();
  console.log(crewTable(ctx.state, ctx.shell, { all: args.flags.all === true }));
}

async function cmdPeek(args: Args): Promise<void> {
  const ctx = await context();
  const c = crewOrFail(ctx.state, args.positional[0]);
  const t = await getThread(c.threadId);
  const reply = lastAssistantText(t);
  const status = parseStatus(reply);
  const prs = [t.branchPullRequest, ...(t.pullRequests ?? [])].filter((p) => p?.url).map((p) => `${p!.url}${p!.state ? ` (${p!.state})` : ""}`);
  const header = [
    `#${c.n} "${t.title}"  [${c.kind}, ${c.model}]`,
    `state:    ${crewState(t)}${t.session?.lastError ? ` — ${oneLine(t.session.lastError, 200)}` : ""}`,
    `thread:   ${t.id}`,
    `branch:   ${t.branch ?? "-"}${c.baseBranch ? ` (base ${c.baseBranch})` : ""}`,
    `worktree: ${t.worktreePath ?? "(main checkout)"}`,
    prs.length ? `PRs:      ${[...new Set(prs)].join(", ")}` : "",
    status ? `status:   ${status.status} — ${status.summary}` : "",
  ].filter(Boolean);
  const body = reply
    ? `--- last reply${args.flags.full ? "" : " (tail)"} ---\n${args.flags.full ? reply : tail(reply, 2500)}`
    : "(no reply yet)";
  console.log(`${header.join("\n")}\n\n${body}`);
}

async function cmdDiff(args: Args): Promise<void> {
  const ctx = await context();
  const c = crewOrFail(ctx.state, args.positional[0]);
  const t = ctx.thread(c.threadId);
  const cwd = t?.worktreePath ?? ctx.project.workspaceRoot;
  if (!existsSync(cwd)) fail(`Worktree ${cwd} no longer exists.`);
  if (!t?.worktreePath) console.error("note: this crewmate works in the main checkout; showing all uncommitted changes there.");
  // The crewmate may have started from, or rebased onto, origin/<base> rather than the local base.
  const base = c.baseBranch ? forkPoint(cwd, c.baseBranch) : null;
  const out: string[] = [];
  if (base) {
    const log = run("git", ["log", "--oneline", `${base}..HEAD`], { cwd });
    out.push(`commits since ${c.baseBranch}:\n${log || "(none)"}`);
  }
  const status = run("git", ["status", "--short"], { cwd });
  if (status) out.push(`uncommitted:\n${status}`);
  out.push(run("git", ["diff", ...(args.flags.stat ? ["--stat"] : []), ...(base ? [base] : [])], { cwd }) || "(no diff)");
  console.log(out.join("\n\n"));
}

/** What `send` and `broadcast` post: the crew brief tells crewmates "[first mate]" means us. */
const toCrew = (t: ShellThread, text: string): Promise<void> => sendMessage(t, `[first mate] ${text.trim()}`);

async function cmdSend(args: Args): Promise<void> {
  const ctx = await context();
  const c = crewOrFail(ctx.state, args.positional[0]);
  const text = await taskText(args, 1);
  const t = ctx.thread(c.threadId) ?? fail(`#${c.n}'s T3 thread is gone.`);
  if (t.archivedAt) fail(`#${c.n} is archived.`);
  const busy = isBusy(t);
  await toCrew(t, text);
  console.log(busy ? `Sent to #${c.n} (it was mid-turn; the message steers the running turn).` : `Sent to #${c.n}; it's working on it.`);
}

async function cmdBroadcast(args: Args): Promise<void> {
  const ctx = await context();
  const text = await taskText(args, 0);
  const exceptRefs = (str(args.flags.except) ?? "").split(/[\s,]+/).filter(Boolean);
  const except = exceptRefs.map((ref) => crewOrFail(ctx.state, ref).n);
  const runningOnly = args.flags.running === true;
  const targets = broadcastTargets(ctx.state, ctx.thread, { runningOnly, except });
  if (!targets.length) {
    console.log(`No ${runningOnly ? "running" : "active"} crewmates to message${except.length ? " (after --except)" : ""}.`);
    return;
  }
  const who = ({ c, t }: (typeof targets)[number]) => `#${c.n} "${oneLine(t.title, 60)}" (${isBusy(t) ? "running: steers its turn" : "idle: starts a new turn"})`;
  if (args.flags["dry-run"]) {
    console.log(`Would send to ${plural(targets.length, "crewmate")}:\n${targets.map((x) => `  ${who(x)}`).join("\n")}\n\n[first mate] ${text.trim()}`);
    return;
  }
  const failed: string[] = [];
  for (const target of targets) {
    try {
      await toCrew(target.t, text);
      console.log(`Sent to ${who(target)}`);
    } catch (error) {
      failed.push(`#${target.c.n}`);
      console.error(`Failed to send to #${target.c.n}: ${(error as Error).message}`);
    }
  }
  if (failed.length) fail(`Not delivered to ${failed.join(", ")}.`);
}

async function cmdStop(args: Args): Promise<void> {
  const ctx = await context();
  const c = crewOrFail(ctx.state, args.positional[0]);
  await interruptThread(c.threadId);
  console.log(`Interrupted #${c.n}.`);
}

/** Wait (briefly) for T3 to report the thread's session stopped. */
async function sessionStopped(threadId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const t = await getThread(threadId).catch(() => undefined);
    if (!t || !hasLiveSession(t)) return;
    await sleep(250);
  }
}

/** Stop what's still running from a retired crewmate's worktree, and say what was stopped. */
async function cleanUpWorktree(ctx: Ctx, t: ShellThread): Promise<void> {
  const wt = t.worktreePath;
  if (!wt) return; // worked in the main checkout: nothing there is the crewmate's alone
  // Paranoia: never treat the main checkout, a directory containing it, or home as the worktree.
  const root = ctx.project.workspaceRoot;
  const contains = (dir: string) => { const rel = relative(wt, dir); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  if (contains(root) || contains(homedir()) || !isAbsolute(wt) || wt.split(sep).filter(Boolean).length < 3) {
    console.log(`  not stopping processes: worktree ${wt} isn't a crewmate's own directory`);
    return;
  }
  const sharing = ctx.shell.threads.filter((o) => o.id !== t.id && !o.archivedAt && o.worktreePath === wt);
  if (sharing.length) {
    console.log(`  not stopping processes: ${wt} is still used by ${plural(sharing.length, "other T3 thread")}`);
    return;
  }
  const { stopped, killed, spared } = await stopWorktreeProcesses(wt);
  const line = (p: { pid: number; command: string }) => `    ${p.pid}  ${oneLine(p.command, 120)}${killed.includes(p.pid) ? "  (SIGKILL)" : ""}`;
  if (stopped.length) console.log(`  stopped ${plural(stopped.length, "process")} running from its worktree:\n${stopped.map(line).join("\n")}`);
  if (spared.length) console.log(`  left ${plural(spared.length, "terminal shell")} open in its worktree:\n${spared.map(line).join("\n")}`);
}

async function cmdArchive(args: Args): Promise<void> {
  const ctx = await context();
  if (!args.positional.length) fail("Which crewmates? e.g. `t3mate archive 3 4`.");
  const keepProcesses = args.flags["keep-processes"] === true;
  for (const ref of args.positional) {
    const c = crewOrFail(ctx.state, ref);
    // The shell snapshot leaves out archived threads; one archived from T3 still has a worktree to clean up.
    const t = ctx.thread(c.threadId) ?? (await getThread(c.threadId).catch(() => undefined));
    // T3's archive leaves the agent's session running; stop it the way T3 does before a delete.
    const stopping = !keepProcesses && t !== undefined && hasLiveSession(t);
    if (stopping) await stopSession(c.threadId).catch((error: Error) => console.error(`  couldn't stop #${c.n}'s T3 session: ${error.message}`));
    if (t && !t.archivedAt) await archiveThread(c.threadId);
    await withState(ctx.project.id, ctx.init, (s) => {
      const m = findCrew(s, String(c.n));
      if (m) m.status = "archived";
      s.pending = s.pending.filter((e) => e.n !== c.n);
    });
    console.log(`Archived #${c.n} "${t?.title ?? c.title}"`);
    if (!keepProcesses && t) {
      if (stopping) await sessionStopped(c.threadId);
      await cleanUpWorktree(ctx, t);
    }
  }
}

async function cmdBacklog(args: Args): Promise<void> {
  const ctx = await context();
  const [sub = "list", ...rest] = args.positional;
  if (sub === "list" || sub === "ls") {
    const open = ctx.state.backlog.filter((b) => !b.done);
    console.log(open.length ? open.map((b) => `${b.n}. ${b.text}`).join("\n") : "(backlog empty)");
    return;
  }
  if (sub === "add") {
    const text = await taskText({ ...args, positional: rest }, 0);
    const n = await withState(ctx.project.id, ctx.init, (s) => {
      const n = s.nextBacklog++;
      s.backlog.push({ n, text: text.trim(), addedAt: nowIso(), done: false });
      return n;
    });
    console.log(`Backlog ${n} added.`);
    return;
  }
  if (sub === "done" || sub === "rm") {
    const n = Number(rest[0]);
    await withState(ctx.project.id, ctx.init, (s) => {
      const item = s.backlog.find((b) => b.n === n) ?? fail(`No backlog item ${rest[0]}.`);
      if (sub === "done") item.done = true;
      else s.backlog = s.backlog.filter((b) => b !== item);
    });
    console.log(`Backlog ${n} ${sub === "done" ? "done" : "removed"}.`);
    return;
  }
  fail("Usage: t3mate backlog add \"<text>\" | list | done <n> | rm <n>");
}

async function cmdDaemon(args: Args): Promise<void> {
  const sub = args.positional[0] ?? "status";
  if (sub === "run") await runDaemon();
  else if (sub === "tick") await tick();
  else if (sub === "install") console.log(await daemonInstall());
  else if (sub === "uninstall") console.log(daemonUninstall());
  else if (sub === "restart") console.log(daemonRestart());
  else if (sub === "logs") console.log(existsSync(DAEMON_LOG) ? readFileSync(DAEMON_LOG, "utf8").trimEnd().split(/\r?\n/).slice(-60).join("\n") : "(no log yet)");
  else if (sub === "status") {
    const pid = daemonPid();
    console.log(pid ? `running (pid ${pid})` : "not running — `t3mate daemon install`");
  } else fail(`Unknown daemon command "${sub}".`);
}

async function cmdConfig(): Promise<void> {
  const ctx = await context();
  console.log(JSON.stringify(ctx.config, null, 2));
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (args.flags.help === true) {
    console.log(HELP);
    return;
  }
  switch (command) {
    case "claim":
      return cmdClaim(args);
    case "brief":
      return cmdBrief();
    case "spawn":
      return cmdSpawn(args);
    case "list":
    case "ls":
    case "status":
      return cmdList(args);
    case "peek":
      return cmdPeek(args);
    case "diff":
      return cmdDiff(args);
    case "send":
      return cmdSend(args);
    case "broadcast":
      return cmdBroadcast(args);
    case "stop":
      return cmdStop(args);
    case "archive":
      return cmdArchive(args);
    case "backlog":
      return cmdBacklog(args);
    case "daemon":
      return cmdDaemon(args);
    case "config":
      return cmdConfig();
    case "install":
      console.log((await install({ rotateToken: args.flags["rotate-token"] === true, noDaemon: args.flags["no-daemon"] === true })).join("\n"));
      return;
    case "uninstall":
      console.log(uninstall().join("\n"));
      return;
    case "doctor": {
      const lines = await doctor();
      console.log(lines.join("\n"));
      if (lines.some((l) => l.startsWith("FAIL"))) process.exitCode = 1;
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`Unknown command "${command}". Run \`t3mate help\`.`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof UserError) {
    console.error(`t3mate: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
