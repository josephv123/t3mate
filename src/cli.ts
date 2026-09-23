import { existsSync, readFileSync } from "node:fs";
import { crewBrief, crewState, crewTable, firstMateBrief, parseStatus } from "./brief.ts";
import type { Config } from "./config.ts";
import { loadConfig, resolveModel } from "./config.ts";
import { daemonPid, runDaemon, tick } from "./daemon.ts";
import { DAEMON_LOG, daemonInstall, daemonRestart, daemonUninstall, doctor, install, uninstall } from "./install.ts";
import { currentBranch, resolveProject } from "./project.ts";
import type { CrewMember, ProjectState } from "./state.ts";
import { emptyState, findCrew, readState, withState } from "./state.ts";
import type { Project, Shell, ShellThread } from "./t3.ts";
import { archiveThread, getShell, getThread, interruptThread, isBusy, lastAssistantText, sendMessage, startThread } from "./t3.ts";
import { UserError, fail, nowIso, oneLine, readStdin, run, sleep, tail, tryRun } from "./util.ts";

const HELP = `t3mate — a first mate for T3 Code

Captain (you): run /firstmate in any T3 thread, in any project, on any harness.
First mate (that thread) uses:
  claim --nonce <random>             make the calling thread this project's first mate
  brief                              playbook + live crew/backlog for this project
  spawn [opts] -- "<task>"           dispatch a crewmate (task may also come via stdin / --file)
      --scout                          deliverable is a report, not a code change
      --title <t>  --model <spec|alias>  --base <branch>  --here (no worktree)  --force
  list [--all]                       crew status
  peek <n> [--full]                  state, branch, PRs, last reply
  diff <n> [--stat]                  crewmate's changes vs its base
  send <n> "<message>"               follow up with / steer a crewmate
  stop <n>                           interrupt a crewmate's running turn
  archive <n>...                     retire crewmates (archives their T3 threads)
  backlog add "<text>" | list | done <n> | rm <n>

Setup:
  install [--rotate-token] [--no-daemon]   link CLI + skills, T3 token, launchd daemon
  uninstall                                undo install (keeps ~/.t3mate)
  doctor                                   check everything
  daemon run|tick|install|uninstall|restart|status|logs
  config                                   show the effective config for this project
`;

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(["nonce", "thread", "title", "model", "base", "file", "runtime-mode"]);

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
  if (!ref) fail("Which crewmate? Pass its number, e.g. `3` or `#3`.");
  return findCrew(state, ref) ?? fail(`No crewmate ${ref} in ${state.title}. See \`t3mate list --all\`.`);
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
  if (!fm) fail("This project has no first mate. Run /firstmate in a T3 thread first.");

  const active = ctx.state.crew.filter((c) => c.status === "active").length;
  if (active >= ctx.config.crew.max_active && !args.flags.force) {
    fail(`${active} crewmates are already active (max_active = ${ctx.config.crew.max_active}). Archive finished ones, backlog this, or pass --force.`);
  }

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

  const n = await withState(ctx.project.id, ctx.init, (s) => s.nextCrew++);
  const threadId = await startThread({
    projectId: ctx.project.id,
    projectRoot: ctx.project.workspaceRoot,
    title: `#${n} ${title}`,
    text: crewBrief({ n, kind, task, worktree, config: ctx.config }),
    modelSelection,
    runtimeMode,
    interactionMode: ctx.config.crew.interaction_mode,
    baseBranch,
    worktree,
    startFromOrigin: ctx.config.crew.start_from_origin,
    runSetupScript: ctx.config.crew.run_setup_script,
  });
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
      watch: {},
    });
  });
  console.log(
    `Spawned #${n} (${kind}) "${title}" → T3 thread ${threadId}\n` +
      `  model ${modelSelection.instanceId}:${modelSelection.model}, ${runtimeMode}, ` +
      (worktree ? `new T3 worktree from ${baseBranch}` : "main checkout"),
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
    `#${c.n} ${c.title}  [${c.kind}, ${c.model}]`,
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
  const base = c.baseBranch ? tryRun("git", ["merge-base", c.baseBranch, "HEAD"], { cwd }) : null;
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

async function cmdSend(args: Args): Promise<void> {
  const ctx = await context();
  const c = crewOrFail(ctx.state, args.positional[0]);
  const text = await taskText(args, 1);
  const t = ctx.thread(c.threadId) ?? fail(`#${c.n}'s T3 thread is gone.`);
  if (t.archivedAt) fail(`#${c.n} is archived.`);
  const busy = isBusy(t);
  await sendMessage(t, `[first mate] ${text.trim()}`);
  console.log(busy ? `Sent to #${c.n} (it was mid-turn; the message steers the running turn).` : `Sent to #${c.n}; it's working on it.`);
}

async function cmdStop(args: Args): Promise<void> {
  const ctx = await context();
  const c = crewOrFail(ctx.state, args.positional[0]);
  await interruptThread(c.threadId);
  console.log(`Interrupted #${c.n}.`);
}

async function cmdArchive(args: Args): Promise<void> {
  const ctx = await context();
  if (!args.positional.length) fail("Which crewmates? e.g. `t3mate archive 3 4`.");
  for (const ref of args.positional) {
    const c = crewOrFail(ctx.state, ref);
    const t = ctx.thread(c.threadId);
    if (t && !t.archivedAt) await archiveThread(c.threadId);
    await withState(ctx.project.id, ctx.init, (s) => {
      const m = findCrew(s, String(c.n));
      if (m) m.status = "archived";
      s.pending = s.pending.filter((e) => e.n !== c.n);
    });
    console.log(`Archived #${c.n} ${c.title}`);
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
  else if (sub === "install") console.log(daemonInstall());
  else if (sub === "uninstall") console.log(daemonUninstall());
  else if (sub === "restart") console.log(daemonRestart());
  else if (sub === "logs") console.log(existsSync(DAEMON_LOG) ? run("tail", ["-n", "60", DAEMON_LOG]) : "(no log yet)");
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
