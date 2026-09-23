import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Config and state paths are resolved from T3MATE_HOME at import time.
const home = mkdtempSync(join(tmpdir(), "t3mate-test-"));
process.env.T3MATE_HOME = home;
const { loadConfig, resolveModel, DEFAULTS } = await import("../src/config.ts");
const { parseStatus, crewBrief } = await import("../src/brief.ts");
const { formatUpdate } = await import("../src/daemon.ts");
const { emptyState, findCrew } = await import("../src/state.ts");

test("parseStatus reads the last T3MATE line in any dash style", () => {
  assert.deepEqual(parseStatus("work\nT3MATE: done — fixed it"), { status: "done", summary: "fixed it" });
  assert.deepEqual(parseStatus("`T3MATE: needs-decision - pick A or B`"), { status: "needs-decision", summary: "pick A or B" });
  assert.deepEqual(parseStatus("T3MATE: blocked — x\nmore\nT3MATE: done – y"), { status: "done", summary: "y" });
  assert.equal(parseStatus("no status here"), null);
});

test("resolveModel handles inherit, specs with options, and aliases", () => {
  const inherit = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const config = { ...DEFAULTS, models: { fast: "codex:gpt-5.6-luna", deep: { model: "claudeAgent:claude-opus-5-5", options: { effort: "high" } } } };
  assert.deepEqual(resolveModel("inherit", config, inherit), inherit);
  assert.deepEqual(resolveModel("codex:gpt-5.4?reasoningEffort=high&fastMode=true", config, inherit), {
    instanceId: "codex",
    model: "gpt-5.4",
    options: [{ id: "reasoningEffort", value: "high" }, { id: "fastMode", value: true }],
  });
  assert.deepEqual(resolveModel("fast", config, inherit), { instanceId: "codex", model: "gpt-5.6-luna" });
  assert.deepEqual(resolveModel("deep", config, inherit), { ...inherit, options: [{ id: "effort", value: "high" }] });
  assert.throws(() => resolveModel("nope", config, inherit), /Unknown model/);
});

test("config layers: later wins, instructions accumulate", () => {
  const root = mkdtempSync(join(tmpdir(), "t3mate-proj-"));
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(join(home, "config.toml"), `[crew]\nstart_from_origin = true\nmodel = "codex:a"\n[instructions]\ncrew = "global rule"\n`);
  writeFileSync(join(home, "projects", `${root.split("/").pop()}.toml`), `[crew]\nmodel = "codex:b"\n`);
  writeFileSync(join(root, ".t3mate.toml"), `[instructions]\ncrew = "repo rule"\n[daemon]\npoll_seconds = 2\n`);
  const config = loadConfig(root);
  assert.equal(config.crew.start_from_origin, true);
  assert.equal(config.crew.model, "codex:b");
  assert.equal(config.crew.worktree, true);
  assert.equal(config.daemon.poll_seconds, 2);
  assert.equal(config.instructions.crew, "global rule\n\nrepo rule");
  assert.equal(loadConfig().crew.model, "codex:a");
});

test("crew brief carries kind rules, project instructions, and the task", () => {
  const config = { ...DEFAULTS, instructions: { firstmate: "", crew: "use pnpm" } };
  const brief = crewBrief({ n: 7, kind: "scout", task: "why is login slow?", worktree: true, config });
  assert.match(brief, /crewmate #7/);
  assert.match(brief, /SCOUT task/);
  assert.match(brief, /use pnpm/);
  assert.match(brief, /TASK:\nwhy is login slow\?/);
  assert.doesNotMatch(brief, /\{\{/);
});

test("formatUpdate lists events by crewmate", () => {
  const state = emptyState("p", "/r", "proj");
  state.crew.push({ n: 2, threadId: "t", title: "dark mode", kind: "ship", task: "", baseBranch: "main", model: "m", createdAt: "", status: "active", watch: {} });
  const events = [{ n: 2, kind: "finished" as const, detail: "done — added toggle", at: "" }];
  const update = formatUpdate(state, events, new Map());
  assert.equal(update.label, "#2 dark mode: finished");
  assert.match(update.text, /^- #2 "dark mode" — finished: done — added toggle\n\nHandle these/);
  const live = new Map([["t", { title: "Add dark mode toggle" } as never]]);
  assert.match(formatUpdate(state, events, live).text, /- #2 "Add dark mode toggle" — finished/);
});

test("skill variants differ only in frontmatter", async () => {
  const { readFileSync } = await import("node:fs");
  const body = (variant: string) =>
    readFileSync(new URL(`../skills/${variant}/t3mate/SKILL.md`, import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  assert.equal(body("claude"), body("codex"));
});

test("findCrew: numbers are crew numbers, otherwise exact or unique long thread-id prefixes", () => {
  const state = emptyState("p", "/r", "proj");
  const mate = (n: number, threadId: string) =>
    state.crew.push({ n, threadId, title: `c${n}`, kind: "ship", task: "", baseBranch: "main", model: "m", createdAt: "", status: "active", watch: {} });
  mate(2, "9d0657f4-5b1e-4c7a-9f0e-2a3b4c5d6e7f");
  mate(9, "938bcbe0-1a2b-4c3d-8e4f-5a6b7c8d9e0f");
  mate(12, "abcdef01-0000-4000-8000-000000000001");
  mate(13, "abcdef01-0000-4000-8000-000000000002");
  const n = (ref: string) => findCrew(state, ref)?.n;

  // Regression: "9" once resolved to #2 because #2's thread id starts with "9".
  assert.equal(n("9"), 9);
  assert.equal(n("#9"), 9);
  assert.equal(n("2"), 2);
  assert.equal(n("#2"), 2);
  assert.equal(n("938"), undefined);
  assert.equal(n("7"), undefined);

  assert.equal(n("9d0657f4-5b1e-4c7a-9f0e-2a3b4c5d6e7f"), 2);
  assert.equal(n("938bcbe0-1a2b-4c3d-8e4f-5a6b7c8d9e0f"), 9);
  assert.equal(n("9d0657f4"), 2);
  assert.equal(n("9d0657f"), undefined);
  assert.equal(n("abcdef01-0000-4000-8000-000000000002"), 13);
  assert.throws(() => findCrew(state, "abcdef01-0000"), /matches more than one crewmate: #12 \(abcdef01-[^)]*\), #13 \(abcdef01-/);
});
