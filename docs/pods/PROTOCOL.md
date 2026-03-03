# Helix Feature Pod Protocol (CTO-grade)

This protocol exists to make multi-agent execution **boring, auditable, and shippable**. It prevents two common failures in agent swarms:

- **Split-brain execution**: everyone “chatting” but no single source of truth.
- **Evidence-free claims**: “it works” without reproducible commands, screenshots, or artifacts.

## Principles (non-negotiable)

- **Coordinator is the hub.** No peer-to-peer agent chat as a coordination mechanism.
- **Files are the contract.** Work state is communicated via versioned artifacts under `.codex/pods/<podId>/`.
- **Evidence before assertions.** “Done” means gates are evidenced (tests + screenshots + reproducible steps), not merely “implemented.”
- **No silent scope creep.** If requirements change, update the contract and re-broadcast.

## Pod directory layout

All pod artifacts live under:

- `.codex/pods/<podId>/`

Required files:

- `.codex/pods/<podId>/CONTRACT.md`
  - Requirements + acceptance criteria + non-negotiable gates + UAT scenarios.
- `.codex/pods/<podId>/PROTOCOL.md`
  - This protocol (comms + update cadence + schema expectations).
- `.codex/pods/<podId>/BOARD.json`
  - Single task board / assignment ledger (coordinator-owned).
- `.codex/pods/<podId>/STATUS.md`
  - Exec-grade narrative status (coordinator-owned).
- `.codex/pods/<podId>/status/<role>.jsonl`
  - Append-only status stream per role (role-owned).
- `.codex/pods/<podId>/evidence/EVIDENCE.json`
  - Gate tracker + evidence registry (gate-owner writes evidence; verifier/coordinator sign off).

## Ownership and write permissions

To prevent “everyone editing everything”:

- Coordinator owns and edits:
  - `CONTRACT.md`
  - `BOARD.json`
  - `STATUS.md`
- Each role may **append** to its own:
  - `status/<role>.jsonl`
- Evidence gates:
  - The gate owner adds evidence entries and proposes `pass|fail`.
  - The verifier/coordinator is responsible for final signoff semantics (and raising waivers in `CONTRACT.md` if ever needed).

## Task board (`BOARD.json`)

Purpose: “who is working on what, what’s blocked, what’s next.”

Shape (minimum):

- `version` (number)
- `podId`, `featureName`, `surfaceTag`
- `integrationBranch`, `defaultBranch`
- `items[]` where each item has:
  - `workItemId` (stable id)
  - `title`
  - `ownerRole`
  - `status` (`todo|doing|blocked|review|done`)
  - `branch`, `pr`
  - `blocker`, `next`

Coordinator rule:

- Only the coordinator changes assignments/owners to prevent duplicate ownership.

## Status stream (`status/<role>.jsonl`)

Purpose: append-only event log so the coordinator can synthesize reality.

Format:

- One JSON object per line (JSONL).
- Append-only: do not rewrite old lines.

Schema (minimum):

- `ts` ISO timestamp
- `role` (string)
- `state` (`todo|doing|blocked|review|done`)
- `workItemId` (string)
- `summary` (string; 1 paragraph max)
- `testsRun` (string[])
- `evidencePaths` (string[]) paths/links to screenshots, Playwright reports, logs
- `blockers` (string[])
- `asks` (string[]) what you need from coordinator/others

Update cadence (minimum):

- At start of work (set `state=doing`)
- When blocked (set `state=blocked` + actionable blocker)
- When opening a PR (include PR link in `evidencePaths` and summary)
- When producing evidence (Playwright report path, screenshots, command outputs)
- When done (only after gates/evidence are satisfied for your slice)

## Evidence registry (`evidence/EVIDENCE.json`)

Purpose: make “ship/no-ship” deterministic.

Gates are explicit and map to “known failure classes” seen in Helix UAT:

- PII leaks in exports
- Encoding corruption (mojibake)
- Readiness vs Data Quality contradictions
- Combined-org circular dependencies / dead ends
- Silent nulls in economics / reconciling numbers
- Workforce grid/API 400/500 when UI claims READY
- Raw JSON errors rendered to execs

Gate expectations:

- `status` is one of: `todo|pass|fail|waived`
- Evidence entries must include:
  - `ts`, `byRole`, `kind`, `ref`, optional `notes`
- A gate is not “pass” without evidence links.

## Coordinator synthesis (`STATUS.md`)

`STATUS.md` is the exec-grade “truth” for humans:

- Headline (1 sentence)
- Blockers (explicit)
- Next (explicit)
- Evidence highlights (links)
- Waivers (if any; must also be recorded in `CONTRACT.md`)

Cadence:

- Update at least when a meaningful milestone occurs (PR opened, gate passed/failed, UAT run, merge readiness).

## Read-only UI (optional)

It is safe to build a read-only viewer over:

- `BOARD.json`
- `STATUS.md`
- `status/*.jsonl`
- `evidence/EVIDENCE.json`

Hard rule:

- The UI must **not** become a second source of truth. It reads only.

## Verification (ship/no-ship)

Run a deterministic gate check from the coordinator workspace (or pass `--repo` to point at an integration branch checkout):

```bash
ao pod verify <podId> --project <projectId>
# or
ao pod verify <podId> --repo <path-to-integration-branch-checkout>
```
