import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Config and state paths are resolved from T3MATE_HOME at import time.
process.env.T3MATE_HOME = mkdtempSync(join(tmpdir(), "t3mate-test-"));
const { DEFAULTS } = await import("../src/config.ts");
const { coalesceEvents, detectLongRunning, detectStall, duration, isOutdated } = await import("../src/daemon.ts");
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
