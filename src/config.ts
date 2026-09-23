// Layered config: built-in defaults < ~/.t3mate/config.toml
//   < ~/.t3mate/projects/<project-dir-name>.toml < <project>/.t3mate.toml
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "smol-toml";
import type { InteractionMode, ModelSelection, RuntimeMode } from "./t3.ts";
import { T3MATE_HOME, fail } from "./util.ts";

export interface Config {
  crew: {
    /** Model spec or alias for crewmates. Unset: same model as the first mate's thread. */
    model?: string;
    /** Unset: same runtime mode as the first mate's thread. */
    runtime_mode?: RuntimeMode;
    interaction_mode: InteractionMode;
    /** Give each crewmate its own T3 worktree. */
    worktree: boolean;
    /** Unset: the project's currently checked-out branch. */
    base_branch?: string;
    start_from_origin: boolean;
    run_setup_script: boolean;
    /** Soft cap on concurrently active crewmates; `spawn --force` overrides. */
    max_active: number;
  };
  /** Aliases usable anywhere a model spec is accepted: "instance:model" or a table. */
  models: Record<string, string | { model: string; options?: Record<string, unknown> }>;
  instructions: {
    /** Appended to the first mate's playbook for this project. */
    firstmate: string;
    /** Appended to every crewmate brief for this project. */
    crew: string;
  };
  daemon: {
    poll_seconds: number;
    /** Tell the first mate when a crew turn has been running this long. 0 disables. */
    stall_minutes: number;
    /** Wait this long after the first crew event so simultaneous events arrive as one message. */
    batch_seconds: number;
  };
}

export const DEFAULTS: Config = {
  crew: {
    interaction_mode: "default",
    worktree: true,
    start_from_origin: false,
    run_setup_script: true,
    max_active: 6,
  },
  models: {},
  instructions: { firstmate: "", crew: "" },
  daemon: { poll_seconds: 5, stall_minutes: 45, batch_seconds: 8 },
};

export const globalConfigPath = (): string => join(T3MATE_HOME, "config.toml");
export const projectConfigPath = (root: string): string => join(T3MATE_HOME, "projects", `${basename(root)}.toml`);
export const repoConfigPath = (root: string): string => join(root, ".t3mate.toml");

function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid TOML in ${path}: ${(error as Error).message}`);
  }
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isTable(v) && isTable(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

export function configLayers(projectRoot?: string): string[] {
  return [globalConfigPath(), ...(projectRoot ? [projectConfigPath(projectRoot), repoConfigPath(projectRoot)] : [])];
}

export function loadConfig(projectRoot?: string): Config {
  const layers = configLayers(projectRoot).map(readToml);
  let merged = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  for (const layer of layers) merged = merge(merged, layer);
  const config = merged as unknown as Config;
  // Instructions add up across layers (global context + project context) instead of replacing.
  for (const key of ["firstmate", "crew"] as const) {
    config.instructions[key] = layers
      .map((layer) => (isTable(layer.instructions) ? layer.instructions[key] : undefined))
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join("\n\n");
  }
  return config;
}

/**
 * Resolve "instance:model", an alias from [models], or "inherit".
 * Options can be appended as "instance:model?effort=high&fastMode=false".
 */
export function resolveModel(spec: string, config: Config, inherit: ModelSelection): ModelSelection {
  if (spec === "inherit") return inherit;
  const alias = config.models[spec];
  if (alias !== undefined) {
    if (typeof alias === "string") return resolveModel(alias, { ...config, models: {} }, inherit);
    const base = resolveModel(alias.model, { ...config, models: {} }, inherit);
    const options = Object.entries(alias.options ?? {}).map(([id, value]) => ({ id, value }));
    return options.length ? { ...base, options } : base;
  }
  const [head, query] = spec.split("?", 2) as [string, string | undefined];
  const colon = head.indexOf(":");
  if (colon <= 0) {
    const aliases = Object.keys(config.models);
    fail(
      `Unknown model "${spec}". Use "instance:model" (e.g. codex:gpt-5.4, claudeAgent:claude-opus-5-5, cursor:composer-2.5)` +
        (aliases.length ? ` or an alias: ${aliases.join(", ")}` : "") +
        ".",
    );
  }
  const selection: ModelSelection = { instanceId: head.slice(0, colon), model: head.slice(colon + 1) };
  if (query) {
    selection.options = [...new URLSearchParams(query)].map(([id, raw]) => ({
      id,
      value: raw === "true" ? true : raw === "false" ? false : raw,
    }));
  }
  return selection;
}
