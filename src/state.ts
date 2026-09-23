// Per-project state on disk: who the first mate is, the crew, the backlog, and
// undelivered crew events. Shared by the CLI and the daemon, so every write
// goes through withState() under a lock.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractionMode, RuntimeMode } from "./t3.ts";
import { T3MATE_HOME, sleep } from "./util.ts";

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
    stallNotifiedTurnId?: string;
  };
}

export interface CrewEvent {
  n: number;
  kind: "finished" | "errored" | "interrupted" | "needs-approval" | "needs-input" | "stalled" | "gone";
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

export function findCrew(state: ProjectState, ref: string): CrewMember | undefined {
  const n = Number(ref.replace(/^#/, ""));
  return state.crew.find((c) => c.n === n || c.threadId === ref || c.threadId.startsWith(ref));
}
