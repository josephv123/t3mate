import { realpathSync } from "node:fs";
import { basename, dirname, normalize, sep } from "node:path";
import type { Project, Shell } from "./t3.ts";
import { fail, tryRun } from "./util.ts";

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The main checkout for cwd, even from inside a (T3) worktree. */
export function repoRoot(cwd: string): string | null {
  const common = tryRun("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  if (!common) return null;
  const path = normalize(common);
  return real(basename(path) === ".git" ? dirname(path) : path);
}

/** Map a directory to its T3 project: exact repo root first, then the deepest containing workspace. */
export function resolveProject(shell: Shell, cwd: string = process.cwd()): Project {
  const projects = shell.projects.filter((p) => !p.deletedAt);
  const candidates = [repoRoot(cwd), real(cwd)].filter((p): p is string => p !== null);
  for (const dir of candidates) {
    const exact = projects.find((p) => real(p.workspaceRoot) === dir);
    if (exact) return exact;
  }
  const here = real(cwd);
  const containing = projects
    .filter((p) => here === real(p.workspaceRoot) || here.startsWith(real(p.workspaceRoot) + sep))
    .sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
  if (containing[0]) return containing[0];
  fail(`${cwd} is not inside any T3 Code project. Open it as a project in T3 first.`);
}

export function currentBranch(root: string): string | null {
  const branch = tryRun("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
  return branch || null;
}
