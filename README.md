# t3mate

A first mate for [T3 Code](https://github.com/pingdotgg/t3code). Type `$t3mate` in any T3 thread, in any project, on any harness (Claude Code, Codex, Cursor, …), and that thread becomes the project's **first mate**. You tell it what you want; it splits the work into tasks, hands each one to a **crewmate** (its own T3 thread in its own T3 worktree), watches them at no model cost, reviews what comes back, and gives you short updates. Everything is a normal T3 thread, so it all works from the T3 phone app too.

Inspired by [firstmate](https://github.com/kunchenguid/firstmate), rebuilt around T3 as the only UI: no tmux or herdr, no running from a special directory, and nothing to set up per project or per harness.

```
you ──► first mate thread ──t3mate spawn──► #1 crewmate thread  (T3 worktree, any model)
             ▲                           └► #2 crewmate thread  (T3 worktree, any model)
             │                                    │
             └──── "[t3mate] Crew update" ◄── daemon (polls T3, zero tokens)
```

## Install

```sh
git clone <this repo> ~/t3mate && ~/t3mate/bin/t3mate install && t3mate doctor
```

`install` does the following:

- links `t3mate` into `~/.local/bin`
- links the `t3mate` skill into `~/.claude/skills`, `~/.codex/skills` and `~/.cursor/skills`
- writes `~/.t3mate/config.toml`
- issues a 90-day T3 access token (label `t3mate`) into Keychain
- starts the launchd daemon (`com.t3mate.daemon`)

Requires macOS, Node ≥ 23.6 (it runs the TypeScript directly), and the T3 Code desktop app running.

**After the first install, quit and reopen T3 Code once.** T3 keeps each project's skill list in memory until it restarts, so `$t3mate` won't appear in the picker before that.

Once the repo is installed, `git pull` updates it; nothing needs re-running unless the release notes say so.

## Use

In T3, open any project, pick any model, and send:

```
$t3mate fix the flaky login test, and figure out why the dashboard is slow
```

The thread claims itself, then works from the playbook in [`playbook/firstmate.md`](playbook/firstmate.md). Crewmate threads appear in the sidebar under the titles T3 generates for them, and the first mate refers to them by those same titles. You can open, watch or step into any of them. Crew updates arrive in the first mate's thread as a one-line `[t3mate] Crew update:` message. The details sit in a collapsed chip: click it to read them. The first mate gets them in full.

Running `$t3mate` again in another thread moves the role there. Each project has one first mate.

## How it maps onto T3

| Concern | Mechanism |
|---|---|
| Crewmate threads + worktrees | T3's own turn-start bootstrap over its websocket RPC: T3 creates the worktree, runs the project's setup script, names the branch, and applies its cleanup policies. |
| Which thread is the first mate | The skill has the agent run `t3mate claim --nonce <random>`. t3mate finds the running thread whose live tool call contains that nonce. That works in every harness, since T3 doesn't expose thread ids to agents. |
| Waking the first mate | The daemon polls T3's shell snapshot and posts a user message into the first mate's thread once it's idle. No harness hooks. T3 only lets clients start a turn with a user message, so the details ride in a T3 context chip to keep the message to one line. |
| Per-project knowledge | None needed: the playbook is global. Projects can add guidance through config (below), and their own AGENTS.md/CLAUDE.md decide how work lands (PR, local merge, …). |
| Auth | A T3 bearer token in Keychain (`t3mate` / `t3-token`), issued with T3's own `t3 auth session issue`. |

Everything T3-specific lives in [`src/t3.ts`](src/t3.ts). T3's API is undocumented and T3 is alpha, so if an update breaks t3mate, that's the file to fix.

## Config

These layers apply in order, with later ones winning. `[instructions]` text accumulates across layers instead of replacing:

1. `~/.t3mate/config.toml`: global defaults
2. `~/.t3mate/projects/<project-dir-name>.toml`: your private per-project overrides
3. `<project>/.t3mate.toml`: committed per-project overrides, shared with the repo

```toml
[crew]
model = "codex:gpt-5.4"          # unset: same model as the first mate thread
runtime_mode = "full-access"     # unset: same as the first mate thread
base_branch = "main"             # unset: project's current branch
worktree = true

[models]                          # aliases for spawn --model
fast = "codex:gpt-5.6-luna"
deep = { model = "claudeAgent:claude-opus-5-5", options = { effort = "high" } }

[instructions]
firstmate = "Small PRs. Always run the e2e suite before calling a task done."
crew = "Use pnpm, never npm."

[daemon]                          # global layer only
poll_seconds = 5
stall_minutes = 45
batch_seconds = 8
```

`t3mate config` prints the effective config for the current project.

Model specs are `instance:model`, with options as a query string (`codex:gpt-5.4?reasoningEffort=high`). They're also accepted in `--model`.

## Ideas borrowed from firstmate (and what was left out)

- **Delegate, don't implement.** The first mate never edits code, which keeps its context small and its thread responsive.
- **Zero-token supervision.** A plain process watches the crew; the model is only woken when something happens.
- **State on disk.** `~/.t3mate/state/<project>.json` holds the crew list, the backlog and undelivered events. `t3mate brief` rebuilds the full picture after compaction or a restart.
- **Ship vs. scout.** Kept as a flag (`--scout`) that changes the crewmate's brief. Its final reply is the report, and "promoting" a scout just means telling the same thread to build it. Firstmate's separate report files, decision gates and promotion scripts are left out; T3 threads already keep the transcript, worktree and context.
- **Left out: delivery modes.** How work lands (PR, local merge, auto-merge) comes from each project's own conventions and your instructions, not from t3mate config.

## Commands

See `t3mate help`. The first mate uses `brief`, `spawn`, `list`, `peek`, `diff`, `send`, `stop`, `archive` and `backlog`. You'll mostly use `install`, `doctor`, `daemon logs` and `config`.

## Layout

```
bin/t3mate          shell entry (resolves symlinks, runs src/cli.ts)
src/t3.ts           T3 adapter: HTTP + websocket RPC, token, T3 CLI
src/cli.ts          commands
src/daemon.ts       supervision loop
src/brief.ts        playbook/brief rendering, crew table, status-line parsing
src/config.ts       layered TOML config + model resolution
src/state.ts        per-project state with a file lock
src/install.ts      install / uninstall / doctor / launchd
playbook/           the first mate playbook and the crewmate brief
skills/             the `t3mate` skill (claude+cursor variant, codex variant)
```
