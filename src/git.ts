// Plain git for the crew's base branch (not T3's API): where new worktrees start, and
// noticing when origin/<base> moves under running crewmates.
import type { StartFromOrigin } from "./config.ts";
import { oneLine, plural, run, tryRun } from "./util.ts";

const FETCH_TIMEOUT_MS = 30_000;
/** Most commits listed in a base-move notice. */
export const BASE_MOVE_LOG_LIMIT = 5;

const git = (cwd: string, args: string[]): string | null => tryRun("git", args, { cwd });
const originRef = (base: string): string => `refs/remotes/origin/${base}`;

export const hasOrigin = (root: string): boolean => git(root, ["remote", "get-url", "origin"]) !== null;

/** origin/<base>'s commit as of the last fetch, or null if there is none. */
export const originHead = (root: string, base: string): string | null =>
  git(root, ["rev-parse", "--verify", "--quiet", `${originRef(base)}^{commit}`]);

export const localHead = (root: string, base: string): string | null =>
  git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);

/**
 * Update origin/<base>. Returns null on success, otherwise a one-line reason. Never prompts,
 * gives up after 30s, and doesn't write FETCH_HEAD, so a `git pull` running in the same
 * checkout can't pick up our fetch instead of its own.
 */
export function fetchBase(root: string, base: string): string | null {
  try {
    run("git", ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", base], {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: FETCH_TIMEOUT_MS,
    });
    return null;
  } catch (error) {
    const e = error as { code?: string; stderr?: string; message: string };
    if (e.code === "ETIMEDOUT") return `git fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    const text = String(e.stderr || e.message);
    return oneLine(text.split("\n").find((l) => l.trim()) ?? "git fetch failed", 200);
  }
}

/** Commits only on the local base (ahead) and only on origin/<base> (behind); null if either is missing. */
export function compareWithOrigin(root: string, base: string): { ahead: number; behind: number } | null {
  const out = git(root, ["rev-list", "--left-right", "--count", `${base}...${originRef(base)}`]);
  const m = out ? /^(\d+)\s+(\d+)$/.exec(out.trim()) : null;
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}

/** Where HEAD forked from <base>: the newer of its merge-bases with the local base and origin/<base>. */
export function forkPoint(cwd: string, base: string): string | null {
  const candidates = [base, originRef(base)]
    .map((ref) => git(cwd, ["merge-base", ref, "HEAD"]))
    .filter((sha): sha is string => !!sha);
  return candidates.reduce<string | null>((best, sha) => (best === null || (sha !== best && isAncestor(cwd, best, sha)) ? sha : best), null);
}

export interface CommitLog {
  /** First-parent commits in from..to: one per merged PR on a merge-commit base. */
  total: number;
  /** Newest first, `<short sha> <subject>`, at most BASE_MOVE_LOG_LIMIT. */
  lines: string[];
}

/** New commits on the base between two commits; null if `from` isn't known in this repo. */
export function newCommits(root: string, from: string, to: string): CommitLog | null {
  const range = `${from}..${to}`;
  const total = git(root, ["rev-list", "--first-parent", "--count", range]);
  if (total === null) return null;
  const log = git(root, ["log", "--first-parent", `--max-count=${BASE_MOVE_LOG_LIMIT}`, "--format=%h %s", range]) ?? "";
  return { total: Number(total), lines: log ? log.split("\n") : [] };
}

/** The notice a running crewmate gets when origin/<base> moves under it. */
export function baseMoveMessage(base: string, head: string, commits: CommitLog | null): string {
  const remote = `origin/${base}`;
  const shown = commits?.lines.slice(0, BASE_MOVE_LOG_LIMIT) ?? [];
  const summary =
    commits && commits.total > 0
      ? [
          `[t3mate] ${remote} moved (${plural(commits.total, "new commit")}):`,
          ...shown.map((line) => `- ${oneLine(line, 100)}`),
          ...(commits.total > shown.length ? [`- … and ${commits.total - shown.length} more`] : []),
        ]
      : [`[t3mate] ${remote} moved to ${head.slice(0, 7)}.`];
  return [...summary, `Rebase onto ${remote} before you push or open a PR.`].join("\n");
}

export interface SpawnBase {
  /** Branch the worktree from origin/<base> instead of the local base. */
  fromOrigin: boolean;
  /** One line for the first mate, if the choice needs explaining. */
  note?: string;
}

/**
 * Where a new worktree branches from. With "auto", `cmp` compares the freshly fetched
 * origin/<base> with the local base (null: no origin/<base>): a local base that is only
 * behind is stale, so use origin; one with local-only commits wins, with a warning.
 */
export function pickSpawnBase(base: string, mode: StartFromOrigin, cmp: { ahead: number; behind: number } | null): SpawnBase {
  if (mode !== "auto") return { fromOrigin: mode };
  if (!cmp) return { fromOrigin: false };
  if (cmp.ahead > 0) {
    const behind = cmp.behind > 0 ? ` and is ${cmp.behind} behind it` : "";
    return {
      fromOrigin: false,
      note: `warning: local ${base} has ${plural(cmp.ahead, "commit")} not on origin/${base}${behind}; starting from local ${base}.`,
    };
  }
  if (cmp.behind > 0) {
    return { fromOrigin: true, note: `note: local ${base} is ${plural(cmp.behind, "commit")} behind origin/${base}; starting from origin/${base}.` };
  }
  return { fromOrigin: false };
}

/** pickSpawnBase against the real repo, fetching origin first in "auto" mode. */
export function resolveSpawnBase(root: string, base: string, mode: StartFromOrigin): SpawnBase {
  if (mode !== "auto" || !hasOrigin(root)) return pickSpawnBase(base, mode, null);
  const error = fetchBase(root, base);
  if (error) {
    // No origin/<base> at all (e.g. a branch that was never pushed) is normal; say nothing.
    return originHead(root, base)
      ? { fromOrigin: false, note: `note: couldn't fetch origin/${base} (${error}); starting from local ${base}.` }
      : { fromOrigin: false };
  }
  return pickSpawnBase(base, mode, compareWithOrigin(root, base));
}
