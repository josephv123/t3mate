# Working on t3mate

- TypeScript run directly by Node's type stripping (Node ≥ 23.6). Only erasable syntax: no enums, namespaces or parameter properties. Import local files with `.ts` extensions.
- Keep every T3 API detail in `src/t3.ts`. T3's server API is internal and changes between releases; the source of truth is `packages/contracts/src/{orchestration,environmentHttp,rpc}.ts` in pingdotgg/t3code.
- Worktree creation must go through the websocket `orchestration.dispatchCommand` with a turn-start `bootstrap`. The HTTP dispatch endpoint ignores `bootstrap`.
- The playbook (`playbook/firstmate.md`) and the crew brief (`playbook/crew.md`) are the product. Keep them harness-neutral: no tool names specific to Claude, Codex or Cursor.
- The two skill variants in `skills/` must stay identical apart from frontmatter (Codex rejects `disable-model-invocation`, and uses `agents/openai.yaml` instead).
- Check with `npm run typecheck && npm test`. For behavior changes, do an end-to-end run against a throwaway git repo added as a T3 project, then delete its threads, worktrees and project.
