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
const { emptyState } = await import("../src/state.ts");

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
  writeFileSync(join(home, "config.toml"), `[crew]\nmax_active = 3\nmodel = "codex:a"\n[instructions]\ncrew = "global rule"\n`);
  writeFileSync(join(home, "projects", `${root.split("/").pop()}.toml`), `[crew]\nmodel = "codex:b"\n`);
  writeFileSync(join(root, ".t3mate.toml"), `[instructions]\ncrew = "repo rule"\n[daemon]\npoll_seconds = 2\n`);
  const config = loadConfig(root);
  assert.equal(config.crew.max_active, 3);
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
  const msg = formatUpdate(state, [{ n: 2, kind: "finished", detail: "done — added toggle", at: "" }]);
  assert.match(msg, /^\[t3mate\] Crew update:\n- #2 dark mode — finished: done — added toggle/);
});

test("skill variants differ only in frontmatter", async () => {
  const { readFileSync } = await import("node:fs");
  const body = (variant: string) =>
    readFileSync(new URL(`../skills/${variant}/firstmate/SKILL.md`, import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
  assert.equal(body("claude"), body("codex"));
});
