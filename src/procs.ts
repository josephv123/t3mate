// Stop processes a crewmate left running from its worktree (servers started with nohup and
// the like), which t3mate doesn't otherwise track. Only ever touches processes whose working
// directory is inside that worktree.
import { spawnSync } from "node:child_process";
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./util.ts";

export interface Proc {
  pid: number;
  ppid: number;
  name?: string;
  /** Controlling terminal, or null for none. */
  tty: string | null;
  command: string;
  cwd: string;
}

export function isInside(path: string, dir: string): boolean {
  const normalizedPath = normalize(path).replaceAll("\\", "/");
  const normalizedDir = normalize(dir).replaceAll("\\", "/").replace(/\/$/, "");
  const p = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const d = process.platform === "win32" ? normalizedDir.toLowerCase() : normalizedDir;
  return p === d || p.startsWith(d + "/");
}

/** Parse `lsof -d cwd -Fpn`: a `p<pid>` line, then `f`/`n<path>` lines for its cwd. */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** Parse `ps -A -o pid=,ppid=,tty=,args=`. */
export function parsePs(out: string): Map<number, Omit<Proc, "cwd">> {
  const procs = new Map<number, Omit<Proc, "cwd">>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const tty = m[3] === "??" || m[3] === "?" || m[3] === "-" ? null : m[3]!;
    procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty, command: m[4]!.trim() });
  }
  return procs;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu"]);
const WINDOWS_SHELLS = new Set([...SHELLS, "pwsh", "powershell", "cmd"]);

/** An interactive shell on a terminal, like the captain's own tab cd'd into the worktree. */
export function isTerminalShell(p: Pick<Proc, "tty" | "command"> & Partial<Pick<Proc, "name">>): boolean {
  if (!p.tty && !(process.platform === "win32" && p.name)) return false;
  const [program = "", ...args] = p.command.split(/\s+/);
  const name = (p.name ?? basename(program)).replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
  if (process.platform === "win32" && p.name) {
    return WINDOWS_SHELLS.has(name) && !/(?:^|\s)(?:\/c|-c|-command|-commandwithargs|-encodedcommand|-file)(?:\s|$)/i.test(p.command);
  }
  return SHELLS.has(name) && !args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a));
}

/** `pid` and its ancestors: the chain running this t3mate command is never stopped. */
export function lineage(procs: Map<number, Pick<Proc, "ppid">>, pid: number): Set<number> {
  const chain = new Set<number>();
  for (let p: number | undefined = pid; p !== undefined && p > 0 && !chain.has(p); p = procs.get(p)?.ppid) chain.add(p);
  return chain;
}

/**
 * Split the processes running from `worktree` into ones to stop and terminal shells to leave
 * alone (reported instead). Nothing outside the worktree, nothing in `protect`, never pid 1.
 */
export function selectWorktreeProcesses(procs: Proc[], worktrees: string[], protect: Set<number>): { stop: Proc[]; spared: Proc[] } {
  const inside = procs.filter((p) => p.pid > 1 && !protect.has(p.pid) && worktrees.some((w) => isInside(p.cwd, w)));
  return { stop: inside.filter((p) => !isTerminalShell(p)), spared: inside.filter(isTerminalShell) };
}

/** Keep all parent links, but only use inspected working directories to select processes. */
export function parseWindowsProcesses(out: string): { table: Map<number, Omit<Proc, "cwd">>; procs: Proc[] } {
  const rows: unknown = JSON.parse(out);
  if (!Array.isArray(rows)) throw new Error("Windows process inventory was not an array");
  const table = new Map<number, Omit<Proc, "cwd">>();
  const procs: Proc[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const p = row as Record<string, unknown>;
    if (!Number.isSafeInteger(p.pid) || !Number.isSafeInteger(p.ppid) || typeof p.command !== "string" || typeof p.name !== "string") continue;
    const base = { pid: p.pid as number, ppid: p.ppid as number, name: p.name, command: p.command, tty: null };
    table.set(base.pid, base);
    if (typeof p.cwd === "string" && p.cwd) procs.push({ ...base, cwd: p.cwd });
  }
  return { table, procs };
}

/** Every process (`table`), and those whose working directory this user can see (`procs`). */
function listProcesses(): { table: Map<number, Omit<Proc, "cwd">>; procs: Proc[] } {
  if (process.platform === "win32") {
    const script = join(fileURLToPath(new URL(".", import.meta.url)), "windows-processes.ps1");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Cannot inspect Windows process directories: ${result.error?.message ?? result.stderr.trim()}`);
    return parseWindowsProcesses(result.stdout);
  }
  const table = parsePs(spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,tty=,args="], { encoding: "utf8" }).stdout ?? "");
  let cwds: Map<number, string>;
  if (process.platform === "linux") {
    cwds = new Map();
    for (const entry of readdirSync("/proc").filter((e) => /^\d+$/.test(e))) {
      try {
        cwds.set(Number(entry), readlinkSync(`/proc/${entry}/cwd`));
      } catch {
        // exited, or another user's process
      }
    }
  } else {
    // lsof exits non-zero when it can't inspect some processes; the rest of its output is still good.
    cwds = parseLsofCwd(spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "");
  }
  const procs = [...table.values()].flatMap((p) => {
    const cwd = cwds.get(p.pid);
    return cwd ? [{ ...p, cwd }] : [];
  });
  return { table, procs };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Cleanup {
  stopped: Proc[];
  /** Still alive after SIGTERM and the grace period; sent SIGKILL. */
  killed: number[];
  spared: Proc[];
}

/** SIGTERM everything running from `worktree`, then SIGKILL whatever outlives `graceMs`. */
export async function stopWorktreeProcesses(worktree: string, graceMs = 3000): Promise<Cleanup> {
  let real = worktree;
  try {
    real = realpathSync(worktree);
  } catch {
    // worktree already removed; processes can still report the old path
  }
  const { table, procs } = listProcesses();
  const protect = lineage(table, process.pid);
  protect.add(process.pid);
  const { stop, spared } = selectWorktreeProcesses(procs, [...new Set([worktree, real])], protect);
  for (const p of stop) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && stop.some((p) => alive(p.pid))) await sleep(100);
  const killed = stop.filter((p) => alive(p.pid)).map((p) => p.pid);
  for (const pid of killed) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // exited in between
    }
  }
  return { stopped: stop, killed, spared };
}
