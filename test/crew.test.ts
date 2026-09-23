import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Config and state paths are resolved from T3MATE_HOME at import time; git must ignore the
// user's own config (signing, hooks, default branch).
const home = mkdtempSync(join(tmpdir(), "t3mate-test-"));
process.env.T3MATE_HOME = home;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const who of ["AUTHOR", "COMMITTER"]) {
  process.env[`GIT_${who}_NAME`] = "t3mate test";
  process.env[`GIT_${who}_EMAIL`] = "test@t3mate.invalid";
}
const { DEFAULTS, loadConfig } = await import("../src/config.ts");
const { baseMoveAction, coalesceEvents, detectLongRunning, detectStall, duration, isOutdated } = await import("../src/daemon.ts");
const { baseMoveMessage, compareWithOrigin, forkPoint, newCommits, pickSpawnBase, resolveSpawnBase } = await import("../src/git.ts");
const { broadcastTargets, emptyState } = await import("../src/state.ts");
type ShellThread = import("../src/t3.ts").ShellThread;
type CrewEvent = import("../src/state.ts").CrewEvent;
type CrewMember = import("../src/state.ts").CrewMember;

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const minsAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

function thread(over: Partial<ShellThread> & { turnStartedMinsAgo?: number; quietMins?: number; turnState?: "running" | "completed" } = {}): ShellThread {
  const { turnStartedMinsAgo = 120, quietMins = 1, turnState = "running", ...rest } = over;
  const running = turnState === "running";
  return {
    id: "t1",
    projectId: "p",
    title: "Fix login",
    modelSelection: { instanceId: "codex", model: "gpt" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "t3code/abc",
    worktreePath: "/Users/x/.t3/worktrees/proj/t3code-abc",
    latestTurn: {
      turnId: "turn-1",
      state: turnState,
      requestedAt: minsAgo(turnStartedMinsAgo),
      startedAt: minsAgo(turnStartedMinsAgo),
      completedAt: running ? null : minsAgo(quietMins),
    },
    session: { status: running ? "running" : "ready", runtimeMode: "full-access", activeTurnId: running ? "turn-1" : null, lastError: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    updatedAt: minsAgo(quietMins),
    ...rest,
  };
}

const ev = (n: number, kind: CrewEvent["kind"], at = minsAgo(0)): CrewEvent => ({ n, kind, detail: kind, at });
const kinds = (events: CrewEvent[]): string[] => events.map((e) => `#${e.n} ${e.kind}`);

// ---------------------------------------------------------------- stall detection

test("stall: a long turn with recent activity is not stalled (the old false positive)", () => {
  assert.equal(detectStall(thread({ turnStartedMinsAgo: 120, quietMins: 2 }), {}, NOW, 15), null);
});

test("stall: no activity for stall_minutes while the turn runs is a stall, reported once per quiet spell", () => {
  const t = thread({ turnStartedMinsAgo: 30, quietMins: 20 });
  const stall = detectStall(t, {}, NOW, 15);
  assert.deepEqual(stall, { activityAt: minsAgo(20), quietMs: 20 * 60_000 });
  assert.equal(detectStall(t, { stallNotifiedActivityAt: stall!.activityAt }, NOW, 15), null);
  // Activity resumed, then went quiet again: a new spell, reported again.
  const again = thread({ turnStartedMinsAgo: 60, quietMins: 16 });
  assert.equal(detectStall(again, { stallNotifiedActivityAt: stall!.activityAt }, NOW, 15)?.activityAt, minsAgo(16));
});

test("stall: never for a finished turn, a settled session, a pending prompt, or when disabled", () => {
  assert.equal(detectStall(thread({ turnState: "completed", quietMins: 60 }), {}, NOW, 15), null);
  const settled = thread({ quietMins: 60 });
  settled.session!.status = "ready"; // T3 settled the session; latestTurn not updated yet
  assert.equal(detectStall(settled, {}, NOW, 15), null);
  assert.equal(detectStall(thread({ quietMins: 60 }), { lastSettledTurnId: "turn-1" }, NOW, 15), null);
  assert.equal(detectStall(thread({ quietMins: 60, hasPendingApprovals: true }), {}, NOW, 15), null);
  assert.equal(detectStall(thread({ quietMins: 60, hasPendingUserInput: true }), {}, NOW, 15), null);
  assert.equal(detectStall(thread({ quietMins: 60 }), {}, NOW, 0), null);
});

test("long-running: once per turn, only while active, only past the threshold", () => {
  const t = thread({ turnStartedMinsAgo: 95, quietMins: 1 });
  assert.deepEqual(detectLongRunning(t, {}, NOW, 90, 15), { turnId: "turn-1", runningMs: 95 * 60_000 });
  assert.equal(detectLongRunning(t, { longRunningNotifiedTurnId: "turn-1" }, NOW, 90, 15), null);
  assert.equal(detectLongRunning(thread({ turnStartedMinsAgo: 45 }), {}, NOW, 90, 15), null);
  assert.equal(detectLongRunning(thread({ turnStartedMinsAgo: 95, quietMins: 20 }), {}, NOW, 90, 15), null, "quiet: that's a stall");
  assert.equal(detectLongRunning(t, {}, NOW, 0, 15), null);
  assert.equal(duration(95 * 60_000), "1h35m");
  assert.equal(duration(7 * 60_000), "7m");
});

test("config: stalls mean 15 quiet minutes; long-running heads-up at 90", () => {
  assert.equal(DEFAULTS.daemon.stall_minutes, 15);
  assert.equal(DEFAULTS.daemon.long_running_minutes, 90);
});

// ---------------------------------------------------------------- event superseding

test("coalesce: a terminal event supersedes earlier undelivered in-turn events for that crewmate", () => {
  assert.deepEqual(kinds(coalesceEvents([ev(19, "stalled"), ev(19, "finished")])), ["#19 finished"]);
  assert.deepEqual(
    kinds(coalesceEvents([ev(3, "needs-approval"), ev(4, "stalled"), ev(3, "long-running"), ev(3, "errored")])),
    ["#4 stalled", "#3 errored"],
  );
  assert.deepEqual(kinds(coalesceEvents([ev(5, "needs-input"), ev(5, "gone")])), ["#5 gone"]);
  assert.deepEqual(kinds(coalesceEvents([ev(6, "stalled"), ev(6, "interrupted")])), ["#6 interrupted"]);
});

test("coalesce: later in-turn events and separate turns are kept; repeats and stale heads-ups collapse", () => {
  // A stall in the next turn is news, and so are two finished turns.
  assert.deepEqual(kinds(coalesceEvents([ev(2, "finished"), ev(2, "stalled")])), ["#2 finished", "#2 stalled"]);
  assert.deepEqual(kinds(coalesceEvents([ev(2, "finished"), ev(2, "finished")])), ["#2 finished", "#2 finished"]);
  // Only the newest of a repeated in-turn event, and a stall replaces "long-running, still active".
  const [a, b] = [ev(7, "stalled", minsAgo(5)), ev(7, "stalled", minsAgo(1))];
  assert.deepEqual(coalesceEvents([a, b]), [b]);
  assert.deepEqual(kinds(coalesceEvents([ev(8, "long-running"), ev(8, "stalled")])), ["#8 stalled"]);
  assert.deepEqual(kinds(coalesceEvents([ev(8, "stalled"), ev(8, "long-running")])), ["#8 stalled", "#8 long-running"]);
});

test("outdated: undelivered events that stopped being true are dropped", () => {
  const stalledAt = minsAgo(3);
  assert.equal(isOutdated(ev(1, "stalled", stalledAt), thread({ quietMins: 20 })), false, "still quiet");
  assert.equal(isOutdated(ev(1, "stalled", stalledAt), thread({ quietMins: 1 })), true, "activity since");
  assert.equal(isOutdated(ev(1, "stalled", stalledAt), thread({ turnState: "completed", quietMins: 20 })), true, "turn done");
  assert.equal(isOutdated(ev(1, "long-running"), thread({ turnState: "completed" })), true);
  assert.equal(isOutdated(ev(1, "needs-approval"), thread()), true);
  assert.equal(isOutdated(ev(1, "needs-approval"), thread({ hasPendingApprovals: true })), false);
  assert.equal(isOutdated(ev(1, "needs-input"), thread({ hasPendingUserInput: true })), false);
  assert.equal(isOutdated(ev(1, "finished"), thread()), false);
  assert.equal(isOutdated(ev(1, "stalled"), undefined), false);
});

// ---------------------------------------------------------------- broadcast

const mate = (n: number, threadId: string, status: CrewMember["status"] = "active"): CrewMember => ({
  n, threadId, title: `c${n}`, kind: "ship", task: "", baseBranch: "main", model: "m", createdAt: "", status, watch: {},
});

test("broadcast targets: live crew, optionally only running, minus exclusions", () => {
  const state = emptyState("p", "/r", "proj");
  state.crew.push(mate(1, "run"), mate(2, "idle"), mate(3, "old", "archived"), mate(4, "archived-in-t3"), mate(5, "gone"), mate(6, "run2"));
  const threads = new Map<string, ShellThread>([
    ["run", thread({ id: "run" })],
    ["idle", thread({ id: "idle", turnState: "completed" })],
    ["old", thread({ id: "old" })],
    ["archived-in-t3", thread({ id: "archived-in-t3", archivedAt: minsAgo(1) })],
    ["run2", thread({ id: "run2" })],
  ]);
  const ns = (opts: Parameters<typeof broadcastTargets>[2]) => broadcastTargets(state, (id) => threads.get(id), opts).map(({ c }) => c.n);
  assert.deepEqual(ns({}), [1, 2, 6]);
  assert.deepEqual(ns({ runningOnly: true }), [1, 6]);
  assert.deepEqual(ns({ except: [1, 2] }), [6]);
  assert.deepEqual(ns({ runningOnly: true, except: [6] }), [1]);
});

// ---------------------------------------------------------------- base branch

test("spawn base: auto starts from origin only when the local base is strictly behind", () => {
  assert.deepEqual(pickSpawnBase("main", "auto", { ahead: 0, behind: 3 }), {
    fromOrigin: true,
    note: "note: local main is 3 commits behind origin/main; starting from origin/main.",
  });
  assert.deepEqual(pickSpawnBase("main", "auto", { ahead: 2, behind: 0 }), {
    fromOrigin: false,
    note: "warning: local main has 2 commits not on origin/main; starting from local main.",
  });
  assert.deepEqual(pickSpawnBase("main", "auto", { ahead: 1, behind: 4 }), {
    fromOrigin: false,
    note: "warning: local main has 1 commit not on origin/main and is 4 behind it; starting from local main.",
  });
  assert.deepEqual(pickSpawnBase("main", "auto", { ahead: 0, behind: 0 }), { fromOrigin: false });
  assert.deepEqual(pickSpawnBase("main", "auto", null), { fromOrigin: false });
  // Explicit settings win either way.
  assert.deepEqual(pickSpawnBase("main", true, { ahead: 2, behind: 0 }), { fromOrigin: true });
  assert.deepEqual(pickSpawnBase("main", false, { ahead: 0, behind: 3 }), { fromOrigin: false });
});

test("config: start_from_origin defaults to auto and rejects anything but true, false or auto", () => {
  assert.equal(DEFAULTS.crew.start_from_origin, "auto");
  assert.equal(DEFAULTS.crew.notify_base_moves, true);
  const root = mkdtempSync(join(tmpdir(), "t3mate-proj-"));
  writeFileSync(join(root, ".t3mate.toml"), `[crew]\nstart_from_origin = "sometimes"\n`);
  assert.throws(() => loadConfig(root), /start_from_origin must be true, false or "auto"/);
  writeFileSync(join(root, ".t3mate.toml"), `[crew]\nstart_from_origin = false\n`);
  assert.equal(loadConfig(root).crew.start_from_origin, false);
});

test("base move message: capped short log, then the rebase instruction", () => {
  assert.equal(
    baseMoveMessage("main", "c3c3c3c3", { total: 2, lines: ["c3c3c3c Fix login redirect (#41)", "b2b2b2b Add dark mode (#40)"] }),
    [
      "[t3mate] origin/main moved (2 new commits):",
      "- c3c3c3c Fix login redirect (#41)",
      "- b2b2b2b Add dark mode (#40)",
      "Rebase onto origin/main before you push or open a PR.",
    ].join("\n"),
  );
  const lines = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `${x.repeat(7)} commit ${x}`);
  const capped = baseMoveMessage("dev", "ffff", { total: 12, lines });
  assert.match(capped, /^\[t3mate\] origin\/dev moved \(12 new commits\):\n- aaaaaaa commit a\n/);
  assert.equal(capped.split("\n").filter((l) => /^- [a-g]{7} /.test(l)).length, 5);
  assert.match(capped, /\n- … and 7 more\nRebase onto origin\/dev before you push or open a PR\.$/);
  assert.match(baseMoveMessage("main", "1234567890", { total: 1, lines: ["1234567 One"] }), /moved \(1 new commit\):/);
  assert.equal(baseMoveMessage("main", "1234567890", null), "[t3mate] origin/main moved to 1234567.\nRebase onto origin/main before you push or open a PR.");
});

test("base move: tell running crewmates once per move; skip idle, prompted, stalled and main-checkout ones", () => {
  const c = (baseSha?: string) => ({ ...mate(1, "t1"), watch: baseSha ? { baseSha } : {} });
  const action = (m: CrewMember, t: ShellThread) => baseMoveAction(m, t, "new", NOW, 15);
  assert.equal(action(c(), thread()), "record");
  assert.equal(action(c("new"), thread()), "skip");
  assert.equal(action(c("old"), thread()), "notify");
  assert.equal(action(c("old"), thread({ turnState: "completed" })), "skip", "finished and idle");
  assert.equal(action(c("old"), thread({ hasPendingUserInput: true })), "skip");
  assert.equal(action(c("old"), thread({ quietMins: 20 })), "skip", "stalled: the notice would mask the stall");
  assert.equal(action(c("old"), thread({ worktreePath: null })), "skip");
});

// Real repos: an "origin" bare repo, the project checkout, and a second clone standing in for merged PRs.
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repos() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t3mate-git-")));
  const origin = join(dir, "origin.git");
  git(dir, "init", "--bare", "-b", "main", origin);
  const project = join(dir, "project");
  git(dir, "clone", "-q", origin, project);
  git(project, "commit", "-q", "--allow-empty", "-m", "initial");
  git(project, "push", "-q", "origin", "main");
  const other = join(dir, "other");
  git(dir, "clone", "-q", origin, other);
  const land = (...subjects: string[]) => {
    for (const s of subjects) git(other, "commit", "-q", "--allow-empty", "-m", s);
    git(other, "push", "-q", "origin", "main");
  };
  return { dir, project, land };
}

test("spawn base against real repos: fetches, then picks origin only for a stale local base", () => {
  const { project, land } = repos();
  assert.deepEqual(resolveSpawnBase(project, "main", "auto"), { fromOrigin: false }, "in sync");
  land("PR one (#1)", "PR two (#2)");
  assert.equal(compareWithOrigin(project, "main")?.behind, 0, "not fetched yet");
  assert.deepEqual(resolveSpawnBase(project, "main", "auto"), {
    fromOrigin: true,
    note: "note: local main is 2 commits behind origin/main; starting from origin/main.",
  });
  assert.equal(existsSync(join(project, ".git", "FETCH_HEAD")), false, "can't disturb a concurrent git pull");
  git(project, "commit", "-q", "--allow-empty", "-m", "local only");
  assert.match(resolveSpawnBase(project, "main", "auto").note ?? "", /^warning: local main has 1 commit not on origin\/main and is 2 behind it/);
  assert.deepEqual(resolveSpawnBase(project, "main", false), { fromOrigin: false });
  assert.deepEqual(resolveSpawnBase(project, "no-such-branch", "auto"), { fromOrigin: false }, "never pushed: quiet");
});

test("forkPoint: a crewmate branched from origin/<base> forks there, not at a stale local base", () => {
  const { project, land } = repos();
  land("PR one (#1)", "PR two (#2)");
  git(project, "fetch", "-q", "origin");
  const head = git(project, "rev-parse", "origin/main");
  // Local main is 2 behind; the crewmate's diff must not include the landed PRs.
  git(project, "checkout", "-q", "-b", "crew", "origin/main");
  git(project, "commit", "-q", "--allow-empty", "-m", "crew work");
  assert.equal(forkPoint(project, "main"), head);
});

test("newCommits lists what landed on origin/<base> since a commit", () => {
  const { project, land } = repos();
  const before = git(project, "rev-parse", "HEAD");
  land("PR one (#1)", "PR two (#2)");
  git(project, "fetch", "-q", "origin");
  const head = git(project, "rev-parse", "origin/main");
  const log = newCommits(project, before, head)!;
  assert.equal(log.total, 2);
  assert.deepEqual(log.lines.map((l) => l.replace(/^\w+ /, "")), ["PR two (#2)", "PR one (#1)"]);
  assert.equal(newCommits(project, "0000000000000000000000000000000000000000", head), null);
});
