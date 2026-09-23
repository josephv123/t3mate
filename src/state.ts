// Per-project state on disk: who the first mate is, the crew, the backlog, and
// undelivered crew events. Shared by the CLI and the daemon, so every write
// goes through withState() under a lock.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractionMode, RuntimeMode } from "./t3.ts";
import { T3MATE_HOME, fail, sleep } from "./util.ts";

export type CrewKind = "ship" | "scout";

export interface CrewMember {
  /** Stable handle for CLI commands; the captain knows crewmates by their T3 title. */
  n: number;
  threadId: string;
  /** Title given at spawn; T3 replaces the thread's title with a generated one. */
  title: string;
  kind: CrewKind;
  task: string;
  baseBranch: string | null;
  model: string;
  createdAt: string;
  status: "active" | "archived";
  /** Daemon bookkeeping. */
  watch: {
    lastSettledTurnId?: string;
    approvalNotified?: boolean;
    inputNotified?: boolean;
    /** The thread's last-activity time when we reported it stalled: one report per quiet spell. */
    stallNotifiedActivityAt?: string;
    longRunningNotifiedTurnId?: string;
  };
}

/** Events that end a turn. They supersede undelivered in-turn events for the same crewmate. */
export const TERMINAL_EVENTS = ["finished", "errored", "interrupted", "gone"] as const;
/** Events about a turn that is still in flight. */
export const IN_TURN_EVENTS = ["needs-approval", "needs-input", "stalled", "long-running"] as const;

export interface CrewEvent {
  n: number;
  kind: (typeof TERMINAL_EVENTS)[number] | (typeof IN_TURN_EVENTS)[number];
  detail: string;
  at: string;
}

export interface BacklogItem {
  n: number;
  text: string;
  addedAt: string;
  done: boolean;
}

export interface ProjectState {
  projectId: string;
  root: string;
  title: string;
  firstMate: {
    threadId: string;
    claimedAt: string;
    runtimeMode: RuntimeMode;
    interactionMode: InteractionMode;
  } | null;
  nextCrew: number;
  crew: CrewMember[];
  nextBacklog: number;
  backlog: BacklogItem[];
  pending: CrewEvent[];
  lastDeliveryError?: string;
}

const stateDir = (): string => join(T3MATE_HOME, "state");
const statePath = (projectId: string): string => join(stateDir(), `${projectId}.json`);

export function emptyState(projectId: string, root: string, title: string): ProjectState {
  return { projectId, root, title, firstMate: null, nextCrew: 1, crew: [], nextBacklog: 1, backlog: [], pending: [] };
}

export function readState(projectId: string): ProjectState | null {
  const path = statePath(projectId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ProjectState;
}

export function listStates(): ProjectState[] {
  if (!existsSync(stateDir())) return [];
  return readdirSync(stateDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => readState(f.slice(0, -5)))
    .filter((s): s is ProjectState => s !== null);
}

async function lock(projectId: string): Promise<() => void> {
  mkdirSync(stateDir(), { recursive: true });
  const dir = join(stateDir(), `${projectId}.lock`);
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(dir);
      return () => rmSync(dir, { recursive: true, force: true });
    } catch {
      // A crashed holder must not wedge everyone: locks are held for milliseconds.
      try {
        if (Date.now() - statSync(dir).mtimeMs > 15_000) rmSync(dir, { recursive: true, force: true });
      } catch {
        // raced with the holder releasing it
      }
      if (attempt > 400) throw new Error(`Timed out waiting for state lock ${dir}`);
      await sleep(25);
    }
  }
}

/** Read-modify-write a project's state atomically. */
export async function withState<T>(
  projectId: string,
  init: () => ProjectState,
  fn: (state: ProjectState) => T | Promise<T>,
): Promise<T> {
  const release = await lock(projectId);
  try {
    const state = readState(projectId) ?? init();
    const result = await fn(state);
    const path = statePath(projectId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);
    return result;
  } finally {
    release();
  }
}

/** Shortest thread-id prefix accepted as a crewmate handle. */
const MIN_THREAD_PREFIX = 8;

/**
 * Resolve a crewmate handle. A number ("9" or "#9") is always the crew number,
 * never a thread-id prefix. Anything else is a full T3 thread id, or a unique
 * prefix of one at least MIN_THREAD_PREFIX characters long.
 */
export function findCrew(state: ProjectState, ref: string): CrewMember | undefined {
  const id = ref.trim();
  const number = /^#?(\d+)$/.exec(id);
  if (number) return state.crew.find((c) => c.n === Number(number[1]));
  const exact = state.crew.find((c) => c.threadId === id);
  if (exact || id.length < MIN_THREAD_PREFIX) return exact;
  const matches = state.crew.filter((c) => c.threadId.startsWith(id));
  if (matches.length > 1) {
    const candidates = matches.map((c) => `#${c.n} (${c.threadId})`).join(", ");
    fail(`"${ref}" matches more than one crewmate: ${candidates}. Use the crew number or the full thread id.`);
  }
  return matches[0];
}
