// Zero-token supervision: poll T3's shell snapshot, turn crew state changes into
// events, and deliver them to the first mate's thread as one message once it is idle.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatus } from "./brief.ts";
import { loadConfig } from "./config.ts";
import type { CrewEvent, CrewMember, ProjectState } from "./state.ts";
import { listStates, withState } from "./state.ts";
import type { ShellThread } from "./t3.ts";
import { getShell, getThread, isBusy, lastAssistantText, renameThread, sendMessage } from "./t3.ts";
import { T3MATE_HOME, nowIso, oneLine, sleep } from "./util.ts";

const log = (msg: string): void => console.log(`${nowIso()} ${msg}`);

async function crewEvents(c: CrewMember, t: ShellThread | undefined, stallMinutes: number): Promise<CrewEvent[]> {
  const events: CrewEvent[] = [];
  const at = nowIso();
  const event = (kind: CrewEvent["kind"], detail: string) => events.push({ n: c.n, kind, detail, at });
  const w = c.watch;

  if (!t) {
    c.status = "archived";
    event("gone", "its T3 thread no longer exists; marked archived");
    return events;
  }
  if (t.archivedAt) {
    c.status = "archived"; // archived from T3 or via t3mate; nothing to report
    return events;
  }

  // T3 names the thread (and its branch) from the task; keep that name but prefix
  // the crew number so the captain can match "#3" in updates to the sidebar.
  if (!w.titled && t.titleState?.source === "manual") w.titled = true;
  if (!w.titled && t.titleState?.source === "generated" && !t.titleState.needsRefinement) {
    if (!t.title.startsWith(`#${c.n} `)) await renameThread(t.id, `#${c.n} ${t.title}`);
    w.titled = true;
  }

  if (t.hasPendingApprovals && !w.approvalNotified) event("needs-approval", "waiting on a T3 approval prompt");
  w.approvalNotified = t.hasPendingApprovals;
  if (t.hasPendingUserInput && !w.inputNotified) event("needs-input", "asked a question and is waiting for an answer");
  w.inputNotified = t.hasPendingUserInput;

  const turn = t.latestTurn;
  if (turn && turn.state !== "running" && !isBusy(t) && turn.turnId !== w.lastSettledTurnId) {
    w.lastSettledTurnId = turn.turnId;
    if (turn.state === "completed") {
      const reply = lastAssistantText(await getThread(t.id));
      const status = parseStatus(reply);
      event(
        "finished",
        status ? `${status.status} — ${status.summary}` : `no T3MATE status line; reply ends: "${oneLine(reply.slice(-240), 240)}"`,
      );
    } else if (turn.state === "error") {
      event("errored", t.session?.lastError ? oneLine(t.session.lastError, 300) : "turn ended in error");
    } else {
      event("interrupted", "turn was interrupted");
    }
  }

  if (
    stallMinutes > 0 &&
    turn?.state === "running" &&
    turn.startedAt &&
    Date.now() - Date.parse(turn.startedAt) > stallMinutes * 60_000 &&
    w.stallNotifiedTurnId !== turn.turnId
  ) {
    w.stallNotifiedTurnId = turn.turnId;
    event("stalled", `current turn has been running for over ${stallMinutes}m`);
  }
  return events;
}

export function formatUpdate(state: ProjectState, events: CrewEvent[]): string {
  const title = (n: number) => oneLine(state.crew.find((c) => c.n === n)?.title ?? "?", 40);
  const lines = events.map((e) => `- #${e.n} ${title(e.n)} — ${e.kind}: ${e.detail}`);
  return [
    `[t3mate] Crew update:`,
    ...lines,
    "",
    "Handle these per the first-mate playbook (`t3mate peek|diff <n>`; `t3mate brief` if you've lost context), then give the captain a short update.",
  ].join("\n");
}

async function tickProject(projectId: string, threads: Map<string, ShellThread>): Promise<void> {
  await withState(
    projectId,
    () => {
      throw new Error(`state for ${projectId} vanished`);
    },
    async (state) => {
      const config = loadConfig(state.root);
      for (const c of state.crew.filter((c) => c.status === "active")) {
        for (const e of await crewEvents(c, threads.get(c.threadId), config.daemon.stall_minutes)) {
          log(`${state.title} #${e.n} ${e.kind}: ${e.detail}`);
          state.pending.push(e);
        }
      }
      if (!state.pending.length || !state.firstMate) return;

      const fm = threads.get(state.firstMate.threadId);
      if (!fm || fm.archivedAt) return; // keep events until a first mate is (re)claimed
      const oldest = Math.min(...state.pending.map((e) => Date.parse(e.at)));
      if (Date.now() - oldest < config.daemon.batch_seconds * 1000) return;
      if (isBusy(fm) || fm.hasPendingApprovals || fm.hasPendingUserInput) return;

      try {
        await sendMessage(fm, formatUpdate(state, state.pending));
        log(`${state.title}: delivered ${state.pending.length} event(s) to first mate`);
        state.pending = [];
        delete state.lastDeliveryError;
      } catch (error) {
        state.lastDeliveryError = `${nowIso()} ${(error as Error).message}`;
        log(`${state.title}: delivery failed: ${(error as Error).message}`);
      }
    },
  );
}

export async function tick(): Promise<void> {
  const states = listStates().filter((s) => s.pending.length || s.crew.some((c) => c.status === "active"));
  if (!states.length) return;
  const shell = await getShell();
  const threads = new Map(shell.threads.map((t) => [t.id, t]));
  for (const s of states) {
    try {
      await tickProject(s.projectId, threads);
    } catch (error) {
      log(`${s.title}: ${(error as Error).message}`);
    }
  }
}

const pidPath = (): string => join(T3MATE_HOME, "daemon.pid");

export function daemonPid(): number | null {
  if (!existsSync(pidPath())) return null;
  const pid = Number(readFileSync(pidPath(), "utf8").trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function runDaemon(): Promise<never> {
  const existing = daemonPid();
  if (existing && existing !== process.pid) {
    log(`another t3mate daemon is running (pid ${existing}); exiting`);
    process.exit(0);
  }
  mkdirSync(T3MATE_HOME, { recursive: true });
  writeFileSync(pidPath(), String(process.pid));
  const cleanup = () => {
    if (daemonPid() === process.pid) rmSync(pidPath(), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  log(`t3mate daemon started (pid ${process.pid})`);
  let lastError = "";
  for (;;) {
    try {
      await tick();
      lastError = "";
    } catch (error) {
      const msg = (error as Error).message;
      if (msg !== lastError) log(`tick failed: ${msg}`); // don't spam while T3 is closed
      lastError = msg;
    }
    await sleep(loadConfig().daemon.poll_seconds * 1000);
  }
}
