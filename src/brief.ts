import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { configLayers } from "./config.ts";
import type { CrewKind, CrewMember, ProjectState } from "./state.ts";
import type { Shell, ShellThread } from "./t3.ts";
import { REPO_ROOT, ago, oneLine } from "./util.ts";

const playbook = (name: string): string => readFileSync(join(REPO_ROOT, "playbook", name), "utf8");

export const STATUS_LINE = /^\s*`?T3MATE:\s*(done|blocked|needs-decision)\s*[—–-]+\s*(.*?)`?\s*$/im;

export function parseStatus(text: string): { status: string; summary: string } | null {
  const lines = text.trimEnd().split("\n").reverse();
  for (const line of lines) {
    const m = STATUS_LINE.exec(line);
    if (m) return { status: m[1]!.toLowerCase(), summary: m[2]!.trim() };
  }
  return null;
}

export function crewBrief(opts: { n: number; kind: CrewKind; task: string; worktree: boolean; config: Config }): string {
  const workspace = opts.worktree
    ? "You are in your own git worktree and branch, made for this task. Stay inside it; don't touch the main checkout or other branches."
    : "You are working directly in the project's main checkout, possibly alongside others. Keep your changes tightly scoped.";
  const kindRules =
    opts.kind === "scout"
      ? "- This is a SCOUT task: the deliverable is knowledge, not a code change. Investigate, reproduce or prototype as needed, but don't commit, push or open PRs. Your final reply IS the report. Make it self-contained: findings, evidence (files, lines, commands), recommendation, open questions.\n"
      : "";
  const project = opts.config.instructions.crew ? `\nProject instructions:\n${opts.config.instructions.crew}\n` : "";
  return playbook("crew.md")
    .replace("{{n}}", String(opts.n))
    .replace("{{workspace_rule}}", workspace)
    .replace("{{kind_rules}}", kindRules)
    .replace("{{project_instructions}}", project)
    .replace("{{task}}", opts.task.trim());
}

export function crewState(t: ShellThread | undefined): string {
  if (!t) return "gone";
  if (t.archivedAt) return "archived";
  if (t.hasPendingApprovals) return "needs-approval";
  if (t.hasPendingUserInput) return "needs-input";
  if (t.latestTurn?.state === "running" || t.session?.status === "running" || t.session?.status === "starting") {
    return "running";
  }
  return t.latestTurn?.state ?? t.session?.status ?? "starting";
}

export function crewTable(state: ProjectState, shell: Shell, opts: { all?: boolean } = {}): string {
  const byId = new Map(shell.threads.map((t) => [t.id, t]));
  const rows = state.crew.filter((c) => opts.all || c.status === "active");
  if (!rows.length) return "(no active crew)";
  return rows
    .map((c: CrewMember) => {
      const t = byId.get(c.threadId);
      const since = t?.latestTurn?.completedAt ?? t?.latestTurn?.startedAt ?? c.createdAt;
      const pr = t?.branchPullRequest?.url ?? t?.pullRequests?.[0]?.url;
      return [
        `#${c.n}`.padEnd(4),
        c.kind.padEnd(5),
        crewState(t).padEnd(14),
        ago(since).padStart(4),
        ` ${oneLine(t?.title ?? c.title, 60)}`,
        t?.branch ? `  [${t.branch}]` : "",
        pr ? `  ${pr}` : "",
      ].join(" ");
    })
    .join("\n");
}

export function firstMateBrief(state: ProjectState, shell: Shell, config: Config): string {
  const aliases = Object.entries(config.models).map(
    ([k, v]) => `${k} = ${typeof v === "string" ? v : v.model + (v.options ? ` ${JSON.stringify(v.options)}` : "")}`,
  );
  const openBacklog = state.backlog.filter((b) => !b.done);
  const sections = [
    playbook("firstmate.md").trimEnd(),
    "---",
    `# This project: ${state.title}`,
    `Root: ${state.root}`,
    `First mate thread: ${state.firstMate?.threadId ?? "(unclaimed)"}`,
    `Config layers (later wins): ${configLayers(state.root).join(" < ")}`,
    `Crewmate default model: ${config.crew.model ?? "same as this thread"}; worktrees: ${config.crew.worktree ? "yes (T3 worktrees)" : "no"}`,
    aliases.length ? `Model aliases:\n${aliases.map((a) => `  ${a}`).join("\n")}` : "",
    config.instructions.firstmate ? `## Project instructions\n${config.instructions.firstmate}` : "",
    `## Crew\n${crewTable(state, shell)}`,
    `## Backlog\n${openBacklog.length ? openBacklog.map((b) => `${b.n}. ${b.text}`).join("\n") : "(empty)"}`,
    state.pending.length ? `## Undelivered crew events\n${state.pending.map((e) => `#${e.n} ${e.kind}: ${e.detail}`).join("\n")}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}
