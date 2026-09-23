import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const T3MATE_HOME = process.env.T3MATE_HOME ?? join(homedir(), ".t3mate");

export class UserError extends Error {}

export function fail(message: string): never {
  throw new UserError(message);
}

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the command after this many milliseconds. */
  timeout?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd();
}

export function tryRun(cmd: string, args: string[], opts: RunOptions = {}): string | null {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Read all of stdin if it is piped; null for a TTY. */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : /(s|sh|ch|x)$/.test(word) ? "es" : "s"}`;
