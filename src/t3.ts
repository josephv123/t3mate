// The only module that knows T3 Code's (unstable, undocumented) server API.
// If a T3 update breaks t3mate, the fix belongs here.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { T3MATE_HOME, fail, newId, nowIso, oneLine, run, tryRun } from "./util.ts";

export const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
export const T3_APP = process.env.T3MATE_T3_APP ?? (process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "t3code")
  : "/Applications/T3 Code (Alpha).app");
const KEYCHAIN_SERVICE = "t3mate";
const KEYCHAIN_ACCOUNT = "t3-token";
export const TOKEN_LABEL = "t3mate";

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: { id: string; value: unknown }[];
}

export interface Project {
  id: string;
  title: string;
  workspaceRoot: string;
  deletedAt: string | null;
}

export interface LatestTurn {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Session {
  status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  runtimeMode: RuntimeMode;
  activeTurnId: string | null;
  lastError: string | null;
}

export interface PullRequestRef {
  url?: string;
  number?: number;
  state?: string;
  title?: string;
}

/** Thread summary as returned by the shell snapshot (no messages). */
export interface ShellThread {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: LatestTurn | null;
  session: Session | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  archivedAt: string | null;
  /**
   * T3's projection bumps this on every thread event: messages (including streamed output),
   * activities (tool calls, subagent progress), session changes and turn diffs. Metadata edits
   * (title, pin, PR sync) bump it too. See `lastActivityAt`.
   */
  updatedAt: string;
  pullRequests?: PullRequestRef[];
  branchPullRequest?: PullRequestRef | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
}

export interface Activity {
  kind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  createdAt: string;
}

export interface ThreadDetail extends ShellThread {
  messages: Message[];
  activities: Activity[];
  deletedAt: string | null;
}

export interface Shell {
  projects: Project[];
  threads: ShellThread[];
}

export function origin(): string {
  if (process.env.T3MATE_T3_ORIGIN) return process.env.T3MATE_T3_ORIGIN;
  try {
    const runtime = JSON.parse(readFileSync(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"));
    if (typeof runtime.port === "number") return `http://127.0.0.1:${runtime.port}`;
  } catch {
    // fall through
  }
  return "http://127.0.0.1:3773";
}

export function readToken(): string | null {
  if (process.env.T3MATE_T3_TOKEN) return process.env.T3MATE_T3_TOKEN;
  if (process.platform === "win32") {
    const result = powershellToken("read");
    return result.status === 0 ? String(result.stdout).trim() || null : null;
  }
  return tryRun("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]);
}

function token(): string {
  return readToken() ?? fail("No T3 token stored. Run `t3mate install`.");
}

export function storeToken(value: string): void {
  if (process.platform === "win32") {
    const result = powershellToken("write", value);
    if (result.status !== 0) fail(`Could not save T3 token: ${String(result.stderr).trim()}`);
    return;
  }
  run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value]);
}

/** Windows DPAPI encrypts the token for the current user; plaintext enters only via stdin. */
function powershellToken(action: "read" | "write" | "delete", value = ""): ReturnType<typeof spawnSync> {
  const path = join(T3MATE_HOME, "token.dpapi");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$path = $env:T3MATE_TOKEN_FILE
if ($env:T3MATE_TOKEN_ACTION -eq 'write') {
  $bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
  $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  [IO.File]::WriteAllBytes($path, $encrypted)
} elseif ($env:T3MATE_TOKEN_ACTION -eq 'read') {
  if (Test-Path -LiteralPath $path) {
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  }
} else { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value, encoding: "utf8", env: { ...process.env, T3MATE_TOKEN_FILE: path, T3MATE_TOKEN_ACTION: action },
  });
}

export function deleteToken(): void {
  if (process.platform === "win32") powershellToken("delete");
  else tryRun("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
}

/** Run T3's own CLI from the installed app bundle. */
export function t3cli(args: string[]): string {
  const exe = process.platform === "win32" ? join(T3_APP, "T3 Code (Alpha).exe") : join(T3_APP, "Contents", "MacOS", "T3 Code (Alpha)");
  const resources = process.platform === "win32" ? join(T3_APP, "resources") : join(T3_APP, "Contents", "Resources");
  const archive = existsSync(join(resources, "server.asar")) ? "server.asar" : "app.asar";
  const entry = join(resources, archive, "apps", "server", "dist", "bin.mjs");
  return run(exe, [entry, ...args, "--base-dir", T3_HOME], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

export function issueToken(): string {
  return t3cli(["auth", "session", "issue", "--ttl", "90d", "--label", TOKEN_LABEL, "--token-only"]).trim();
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${origin()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    fail(`Cannot reach T3 Code at ${origin()} — is the app running? (${(cause as Error).message})`);
  }
  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    fail(`T3 rejected the t3mate token (${res.status}). Run \`t3mate install --rotate-token\`.`);
  }
  if (!res.ok) fail(`T3 ${init.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 500)}`);
  return (body ? JSON.parse(body) : null) as T;
}

export const getShell = (): Promise<Shell> => http<Shell>("/api/orchestration/shell");

export async function getThread(threadId: string): Promise<ThreadDetail> {
  const res = await http<ThreadDetail | { thread: ThreadDetail }>(`/api/orchestration/threads/${threadId}`);
  return "thread" in res ? res.thread : res;
}

export const dispatch = (command: Record<string, unknown>): Promise<{ sequence: number }> =>
  http("/api/orchestration/dispatch", { method: "POST", body: JSON.stringify(command) });

/**
 * One request over T3's websocket RPC (Effect RPC, JSON serialization).
 * Needed for commands whose side effects live in the websocket handler —
 * notably turn-start bootstrap, which creates T3 worktrees and runs setup scripts.
 */
async function rpc<T>(tag: string, payload: unknown, timeoutMs = 180_000): Promise<T> {
  const { ticket } = await http<{ ticket: string }>("/api/auth/websocket-ticket", { method: "POST" });
  const wsUrl = `${origin().replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`;
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`T3 rpc ${tag} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      ws.close();
      fn();
    };
    ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
    ws.onerror = () => finish(() => reject(new Error(`T3 websocket error during ${tag}`)));
    ws.onmessage = (event) => {
      const messages = [JSON.parse(String(event.data))].flat();
      for (const msg of messages) {
        if (msg._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag === "Exit" && msg.requestId === "1") {
          if (msg.exit?._tag === "Success") finish(() => resolve(msg.exit.value as T));
          else finish(() => reject(new Error(`T3 rejected ${tag}: ${JSON.stringify(msg.exit).slice(0, 800)}`)));
        }
        if (msg._tag === "Defect" || msg._tag === "ClientProtocolError") {
          finish(() => reject(new Error(`T3 rpc ${tag} failed: ${JSON.stringify(msg).slice(0, 800)}`)));
        }
      }
    };
  });
}

export interface StartThreadInput {
  projectId: string;
  projectRoot: string;
  title: string;
  text: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  baseBranch: string | null;
  worktree: boolean;
  startFromOrigin: boolean;
  runSetupScript: boolean;
}

/** Create a thread and send its first message, the same way T3's composer does. */
export async function startThread(input: StartThreadInput): Promise<string> {
  const threadId = newId();
  const createdAt = nowIso();
  const useWorktree = input.worktree && input.baseBranch !== null;
  await rpc("orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: newId(),
    threadId,
    message: { messageId: newId(), role: "user", text: input.text, attachments: [] },
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.baseBranch,
        worktreePath: null,
        createdAt,
      },
      ...(useWorktree
        ? {
            prepareWorktree: {
              projectCwd: input.projectRoot,
              baseBranch: input.baseBranch,
              requireWorktree: true,
              // T3's temporary-branch prefix, so T3 names/manages it like its own.
              branch: `t3code/${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
              ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: input.runSetupScript,
          }
        : {}),
    },
    createdAt,
  });
  return threadId;
}

/** Detail T3 shows as a collapsed chip in the message; the agent still receives all of it. */
export interface Collapsed {
  label: string;
  title: string;
  text: string;
}

async function supportsInlineContext(): Promise<boolean> {
  const env = await http<{ capabilities?: { inlineMessageContext?: boolean } }>("/.well-known/t3/environment");
  return env.capabilities?.inlineMessageContext === true;
}

/**
 * T3's composer context: a `t3-context://` link in the text marks where the chip goes, and a
 * record carries its payload, which the server expands for the agent. The terminal kind is the
 * one whose chip shows arbitrary text (in a popover); unknown kinds render as "unavailable".
 */
function withCollapsed(text: string, c: Collapsed): { text: string; context: unknown } {
  const contextId = `t3mate-${newId()}`;
  const label = oneLine(c.label.replace(/[[\]\\]/g, " "), 200) || "details";
  const body = c.text.slice(0, 64_000);
  return {
    text: `${text} [${label}](t3-context://v1/terminal/${contextId})`,
    context: {
      version: 1,
      records: [
        {
          version: 1,
          kind: "terminal",
          contextId,
          label,
          terminalId: "t3mate",
          terminalLabel: oneLine(c.title, 255),
          lineStart: 1,
          lineEnd: body.split("\n").length,
          text: body,
        },
      ],
    },
  };
}

/**
 * Post a user message into an existing thread. Steers the agent if it is mid-turn.
 * `collapsed` rides along as a chip, or as plain text on T3 builds without inline context.
 */
export async function sendMessage(
  thread: Pick<ShellThread, "id" | "runtimeMode" | "interactionMode">,
  text: string,
  collapsed?: Collapsed,
): Promise<void> {
  const message = !collapsed
    ? { text }
    : (await supportsInlineContext())
      ? withCollapsed(text, collapsed)
      : { text: `${text} ${collapsed.label}\n\n${collapsed.text}` };
  await dispatch({
    type: "thread.turn.start",
    commandId: newId(),
    threadId: thread.id,
    message: { messageId: newId(), role: "user", attachments: [], ...message },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: nowIso(),
  });
}

export async function archiveThread(threadId: string): Promise<void> {
  await dispatch({ type: "thread.archive", commandId: newId(), threadId });
}

export async function interruptThread(threadId: string): Promise<void> {
  await dispatch({ type: "thread.turn.interrupt", commandId: newId(), threadId, createdAt: nowIso() });
}

/** Whether the thread has a provider session (agent process) T3 could stop. */
export const hasLiveSession = (thread: ShellThread): boolean => thread.session !== null && thread.session.status !== "stopped";

/**
 * Stop the thread's provider session (the agent process), as T3 does before deleting a thread
 * and when it settles one. Archiving alone leaves the session running.
 */
export async function stopSession(threadId: string): Promise<void> {
  await dispatch({ type: "thread.session.stop", commandId: newId(), threadId, createdAt: nowIso() });
}

export function isBusy(thread: ShellThread): boolean {
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting"
  );
}

/** The latest turn if it is still in flight: T3 hasn't settled it and the session is live. */
export function runningTurn(thread: ShellThread): LatestTurn | null {
  const turn = thread.latestTurn;
  if (!turn || turn.state !== "running" || turn.completedAt) return null;
  if (thread.session && thread.session.status !== "running" && thread.session.status !== "starting") return null;
  return turn;
}

/**
 * When the thread last showed signs of life, from the shell snapshot alone (no extra request).
 * `updatedAt` moves with every message, streamed output, tool call and activity T3 records.
 */
export function lastActivityAt(thread: ShellThread): string {
  const times = [thread.updatedAt, thread.latestTurn?.startedAt, thread.latestTurn?.requestedAt].filter(
    (t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)),
  );
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), times[0] ?? new Date(0).toISOString());
}

/** One line on the thread's most recent tool call or activity, e.g. `Command run (Bash: npm test)`. */
export function lastActivityNote(thread: ThreadDetail): string | null {
  const activity = thread.activities.findLast((a) => a.kind !== "context-window.updated" && a.kind !== "checkpoint.captured");
  if (!activity) return null;
  const payload = activity.payload as { detail?: unknown } | null;
  const detail = typeof payload?.detail === "string" && !/:\s*\{\}$/.test(payload.detail) ? payload.detail : "";
  return oneLine(detail ? `${activity.summary} (${detail})` : activity.summary, 160);
}

export function lastAssistantText(thread: ThreadDetail): string {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.role === "assistant" && m.text.trim()) return m.text;
  }
  return "";
}
