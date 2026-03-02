# AGENTS.md (agent-orchestrator)

This repository is an orchestration tool. Changes here affect how pods are spawned, how prompts are delivered, and how evidence is collected. Treat it as operational infrastructure: small diffs, backwards compatibility, and cross-platform correctness.

## Non-negotiables

- **Cross-platform bar (Windows is first-class).**
  - Do not introduce bash-only syntax in launch commands (no `$(cat ...)`, process substitution, `/dev/null`, etc.).
  - If you need file content at launch time, prefer **Node file reads** and pass strings explicitly.
  - Assume `runtime: process` may run under `cmd.exe` when `shell:true` is used.

- **Security and secret hygiene**
  - **Never** commit secrets, tokens, or `.env` files.
  - **Do not bypass** secret scanning (`--no-verify`) unless a human explicitly approves.
  - Keep the `gitleaks` pre-commit hook passing.

- **Backwards compatibility**
  - Config schema changes must be additive and optional.
  - If you change any on-disk artifact schema (board/status/evidence), bump `version` fields and update docs.

- **Quality gates for any code change**
  - Run: `pnpm -w typecheck`
  - If you touched process spawning, prompt delivery, or parsing, add/adjust tests where feasible.

- **Operational safety**
  - No destructive commands (`git reset --hard`, `git clean`, deleting worktrees) unless explicitly requested.
  - Keep changes scoped; avoid repo-wide refactors and dependency upgrades unless explicitly requested.

## Pod protocol

Pods are hub-and-spoke:

- The **coordinator** is the hub and owns assignment + synthesis.
- Workers communicate via **append-only status streams** and evidence links.

Protocol source of truth:

- `docs/pods/PROTOCOL.md`

If you modify pod comms behavior or artifacts produced by `ao pod start`, update:

- `docs/pods/PROTOCOL.md`
- `packages/cli/src/commands/pod.ts` (templates + prompts)
- `examples/*` if config/flags changed

