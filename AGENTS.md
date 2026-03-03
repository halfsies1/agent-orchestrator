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

## Operator runbook (CTO-grade)

### Do you need to keep `ao` running as a process?

- **No** for day-to-day usage: `ao` is a CLI that reads/writes session metadata. You can run commands and exit.
- **Yes** only if you want the **web dashboard server** to keep running:
  - `ao dashboard` keeps the dashboard process alive in your terminal.
  - `ao start` also keeps running if it successfully started the dashboard.
- The orchestrator agent itself should run in your configured runtime (recommended: `tmux`) and is not tied to the `ao` CLI process.

### Minimal setup

1. Install CLI (if published): `npm install -g @composio/agent-orchestrator`
2. Configure a project: `ao init --auto`
3. Start orchestrator: `ao start`
4. (Optional) Start dashboard from a source checkout: `ao dashboard`

### Pod workflow (Helix-style)

1. Start a pod: `ao pod start <podId> --project <projectId> --feature "<name>" --surface <tag>`
2. Track progress:
   - `ao pod status <podId> --board`
   - `ao pod status <podId> --updates --tail 50`
   - `ao pod status <podId> --evidence`
3. Change requirements: edit `.codex/pods/<podId>/CONTRACT.md`, then `ao pod sync <podId>`.

### Merge-to-main (merge captain workflow)

Goal: keep merges **serialized and boring**.

1. Each worker PR targets the pod integration branch (created by `ao pod start`).
2. Merge worker PRs into the integration branch only after:
   - required tests are green, and
   - evidence is captured/linked in `.codex/pods/<podId>/evidence/EVIDENCE.json`.
3. Merge the integration PR to `main` only after:
   - verifier gates are green, and
   - decision guardian sign-off is recorded (acceptance criteria met, governance language correct).
4. Never rely on “agent confidence”. Merge only with evidence.
