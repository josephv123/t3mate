import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { globalConfigPath } from "./config.ts";
import { daemonPid } from "./daemon.ts";
import { T3_APP, TOKEN_LABEL, getShell, issueToken, origin, readToken, storeToken, t3cli } from "./t3.ts";
import { REPO_ROOT, T3MATE_HOME, run, sleep, tryRun } from "./util.ts";

const HOME = homedir();
const BIN_LINK = join(HOME, ".local", "bin", "t3mate");
const LAUNCHD_LABEL = "com.t3mate.daemon";
const PLIST = join(HOME, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
export const DAEMON_LOG = join(T3MATE_HOME, "daemon.log");

export const SKILL_NAME = "t3mate";
/** Names earlier versions installed under; removed on install if they point into this repo. */
const LEGACY_SKILL_NAMES = ["firstmate"];

/**
 * Skill install targets: [harness home, skills dir, variant]. Claude and Cursor honor
 * `disable-model-invocation`; Codex rejects it and uses agents/openai.yaml instead.
 */
const SKILL_TARGETS: [string, string, "claude" | "codex"][] = [
  [join(HOME, ".claude"), join(HOME, ".claude", "skills"), "claude"],
  [join(HOME, ".codex"), join(HOME, ".codex", "skills"), "codex"],
  [join(HOME, ".cursor"), join(HOME, ".cursor", "skills"), "claude"],
];

function link(target: string, path: string): string {
  let existing: string | null = null;
  try {
    existing = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : "(not a symlink)";
  } catch {
    // absent
  }
  if (existing === target) return `ok       ${path}`;
  if (existing === "(not a symlink)") return `SKIPPED  ${path} exists and is not a symlink; remove it to let t3mate manage it`;
  if (existing !== null) rmSync(path);
  symlinkSync(target, path);
  return `linked   ${path} -> ${target}`;
}

/** Remove a symlink only if it points into this repo. */
function unlinkOwned(path: string): string | null {
  try {
    if (lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith(REPO_ROOT)) {
      rmSync(path);
      return `removed  ${path}`;
    }
  } catch {
    // absent
  }
  return null;
}

const CONFIG_TEMPLATE = `# t3mate global config. Layers (later wins):
#   ~/.t3mate/config.toml < ~/.t3mate/projects/<project-dir-name>.toml < <project>/.t3mate.toml
# [instructions] text accumulates across layers instead of replacing.

[crew]
# model = "codex:gpt-5.4"        # unset: crewmates use the first mate thread's model
# runtime_mode = "full-access"   # unset: same as the first mate thread
# base_branch = "main"           # unset: the project's current branch
# worktree = true                # each crewmate gets its own T3 worktree
# start_from_origin = "auto"     # auto: origin/<base> when the local base is only behind it; true/false to force
# run_setup_script = true        # run the T3 project's worktree setup script
# notify_base_moves = true       # tell running crewmates to rebase when origin/<base> moves

[models]
# fast = "codex:gpt-5.6-luna"
# deep = { model = "claudeAgent:claude-opus-5-5", options = { effort = "high" } }

[instructions]
# firstmate = "Extra standing guidance for every first mate."
# crew = "Extra standing guidance for every crewmate."

[daemon]
# poll_seconds = 5
# stall_minutes = 15             # running turn with no activity (output, tool calls) this long
# long_running_minutes = 90      # one informational heads-up per turn that runs this long
# batch_seconds = 8
`;

function plist(): string {
  const path = [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${join(REPO_ROOT, "src", "cli.ts")}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${DAEMON_LOG}</string>
  <key>StandardErrorPath</key><string>${DAEMON_LOG}</string>
</dict>
</plist>
`;
}

const uid = (): string => String(process.getuid?.() ?? run("id", ["-u"]));

const loaded = (): boolean => tryRun("launchctl", ["print", `gui/${uid()}/${LAUNCHD_LABEL}`]) !== null;

export async function daemonInstall(): Promise<string> {
  mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(T3MATE_HOME, { recursive: true });
  // bootout returns before the job is gone; bootstrapping too early fails with EIO.
  tryRun("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  for (let i = 0; i < 50 && loaded(); i++) await sleep(100);
  writeFileSync(PLIST, plist());
  for (let attempt = 1; ; attempt++) {
    try {
      run("launchctl", ["bootstrap", `gui/${uid()}`, PLIST]);
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
      await sleep(500 * attempt);
    }
  }
  return `daemon   launchd ${LAUNCHD_LABEL} (log: ${DAEMON_LOG})`;
}

export function daemonUninstall(): string {
  tryRun("launchctl", ["bootout", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  rmSync(PLIST, { force: true });
  return `removed  launchd ${LAUNCHD_LABEL}`;
}

export function daemonRestart(): string {
  run("launchctl", ["kickstart", "-k", `gui/${uid()}/${LAUNCHD_LABEL}`]);
  return "restarted daemon";
}

async function tokenWorks(): Promise<boolean> {
  if (!readToken()) return false;
  try {
    await getShell();
    return true;
  } catch {
    return false;
  }
}

/** Revoke t3mate-labelled T3 sessions, keeping the newest one when `keepNewest`. */
function revokeOldTokens(keepNewest: boolean): void {
  const sessions = JSON.parse(t3cli(["auth", "session", "list", "--json"])) as {
    sessionId: string;
    client?: { label?: string };
    issuedAt: string;
  }[];
  const ours = sessions.filter((s) => s.client?.label === TOKEN_LABEL).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  for (const s of ours.slice(keepNewest ? 1 : 0)) t3cli(["auth", "session", "revoke", s.sessionId]);
}

export async function install(opts: { rotateToken: boolean; noDaemon: boolean }): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(join(REPO_ROOT, "node_modules", "smol-toml"))) {
    run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: REPO_ROOT });
    out.push("deps     npm install");
  }

  mkdirSync(join(HOME, ".local", "bin"), { recursive: true });
  out.push(link(join(REPO_ROOT, "bin", "t3mate"), BIN_LINK));
  if (!(process.env.PATH ?? "").split(delimiter).includes(join(HOME, ".local", "bin"))) {
    out.push(`WARNING  ~/.local/bin is not on PATH; agents won't find \`t3mate\``);
  }

  let skillsChanged = false;
  for (const [harnessHome, skillsDir, variant] of SKILL_TARGETS) {
    if (!existsSync(harnessHome)) {
      out.push(`skip     ${skillsDir} (harness not installed)`);
      continue;
    }
    mkdirSync(skillsDir, { recursive: true });
    for (const legacy of LEGACY_SKILL_NAMES) {
      const removed = unlinkOwned(join(skillsDir, legacy));
      if (removed) out.push(removed);
    }
    const result = link(join(REPO_ROOT, "skills", variant, SKILL_NAME), join(skillsDir, SKILL_NAME));
    skillsChanged ||= !result.startsWith("ok");
    out.push(result);
  }
  if (skillsChanged) {
    // T3 caches each project's skill list in memory until the app restarts.
    out.push(`NOTE     Quit and reopen T3 Code once so its $ picker shows the "${SKILL_NAME}" skill.`);
  }

  mkdirSync(T3MATE_HOME, { recursive: true });
  if (!existsSync(globalConfigPath())) {
    writeFileSync(globalConfigPath(), CONFIG_TEMPLATE);
    out.push(`config   wrote ${globalConfigPath()}`);
  }

  if (opts.rotateToken || !(await tokenWorks())) {
    storeToken(issueToken());
    revokeOldTokens(true);
    out.push(`token    issued a 90-day T3 token (label "${TOKEN_LABEL}") into Keychain`);
  } else {
    out.push("token    ok");
  }

  if (!opts.noDaemon) out.push(await daemonInstall());
  return out;
}

export function uninstall(): string[] {
  const out = [daemonUninstall()];
  for (const [, skillsDir] of SKILL_TARGETS) {
    for (const name of [SKILL_NAME, ...LEGACY_SKILL_NAMES]) {
      const removed = unlinkOwned(join(skillsDir, name));
      if (removed) out.push(removed);
    }
  }
  try {
    if (lstatSync(BIN_LINK).isSymbolicLink()) {
      rmSync(BIN_LINK);
      out.push(`removed  ${BIN_LINK}`);
    }
  } catch {
    // absent
  }
  try {
    revokeOldTokens(false);
    tryRun("security", ["delete-generic-password", "-s", "t3mate", "-a", "t3-token"]);
    out.push("revoked  t3mate T3 token(s)");
  } catch (error) {
    out.push(`WARNING  could not revoke tokens: ${(error as Error).message}`);
  }
  out.push(`kept     ${T3MATE_HOME} (state + config); delete it yourself if you want`);
  return out;
}

export async function doctor(): Promise<string[]> {
  const out: string[] = [];
  const check = (ok: boolean, label: string, hint = "") => out.push(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && hint ? ` — ${hint}` : ""}`);
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  check(major > 23 || (major === 23 && minor >= 6), `node ${process.versions.node}`, "need >= 23.6 for TypeScript type stripping");
  check(existsSync(T3_APP), `T3 Code app at ${T3_APP}`, "set T3MATE_T3_APP");
  check(await tokenWorks(), `T3 API at ${origin()} with Keychain token`, "open T3 Code, then `t3mate install --rotate-token`");
  check(tryRun("which", ["t3mate"]) !== null, "t3mate on PATH", "run `t3mate install`; ensure ~/.local/bin is on PATH");
  for (const [harnessHome, skillsDir] of SKILL_TARGETS) {
    if (existsSync(harnessHome)) check(existsSync(join(skillsDir, SKILL_NAME, "SKILL.md")), `skill in ${skillsDir}`, "run `t3mate install`");
  }
  const pid = daemonPid();
  check(pid !== null, `daemon running${pid ? ` (pid ${pid})` : ""}`, "`t3mate daemon install`");
  return out;
}
