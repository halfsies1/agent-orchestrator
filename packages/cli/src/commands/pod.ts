import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  updateMetadata,
  getSessionsDir,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@composio/ao-core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";

function slugify(input: string): string {
  const s = (input ?? "").trim().toLowerCase();
  if (!s) return "feature";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeIntegrationBranch(surfaceTag: string, featureName: string): string {
  const surface = slugify(surfaceTag).replace(/-/g, "_");
  const slug = slugify(featureName);
  return `feat/${surface}-${slug}`;
}

function makeRoleBranch(integrationBranch: string, roleSuffix: string): string {
  // integrationBranch is "feat/<slug>" — keep it stable and append suffix.
  const base = integrationBranch.replace(/^feat\//, "");
  const suffix = slugify(roleSuffix);
  return `feat/${base}-${suffix}`;
}

function safeFsName(input: string): string {
  return String(input ?? "")
    .trim()
    .replace(/[\\/]+/g, "__")
    .replace(/[:*?"<>|]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function extractPrUrl(output: string): string | null {
  const m = output.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
  return m ? m[0] : null;
}

async function bestEffortCreateDraftPr(
  project: ProjectConfig,
  workspacePath: string,
  integrationBranch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<string | null> {
  // Ensure branch is pushed; gh may prompt interactively otherwise.
  await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: workspacePath });

  const { stdout, stderr } = await exec(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      project.repo,
      "--head",
      integrationBranch,
      "--base",
      baseBranch,
      "--draft",
      "--title",
      title,
      "--body",
      body,
    ],
    { cwd: workspacePath },
  );

  return extractPrUrl(stdout) ?? extractPrUrl(stderr);
}

function sanitizeForHandoffFileName(s: string): string {
  // Must match Helix scripts/worktree-handoff.ps1 Sanitize()
  const out = String(s ?? "")
    .replace(/[\\/]+/g, "__")
    .replace(/[:*?"<>|]/g, "_");
  return out.length > 120 ? out.slice(0, 120) : out;
}

function handoffFilePath(workspacePath: string, branch: string): string {
  const name = sanitizeForHandoffFileName(branch);
  return join(workspacePath, ".codex", "worktrees", `${name}.md`);
}

function updateHandoffMarkdown(
  raw: string,
  updates: { prUrl?: string; goal?: string; now?: string; next?: string },
): string {
  const lines = raw.split(/\r?\n/);

  // Simple line replacements
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (updates.prUrl && /^-\s*PR:\s*/.test(line)) {
      lines[i] = `- PR: ${updates.prUrl}`;
    } else if (updates.now && /^-\s*Now:\s*/.test(line)) {
      lines[i] = `- Now: ${updates.now}`;
    } else if (updates.next && /^-\s*Next:\s*/.test(line)) {
      lines[i] = `- Next: ${updates.next}`;
    }
  }

  // Goal: replace the first non-empty line after "## Goal"
  if (updates.goal) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "## Goal") {
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j].trim();
          if (!t) continue;
          lines[j] = updates.goal;
          i = lines.length; // break outer
          break;
        }
        break;
      }
    }
  }

  return lines.join("\n");
}

function defaultOwner(): string {
  return (
    process.env["AO_OWNER"] ||
    process.env["GIT_AUTHOR_NAME"] ||
    process.env["USERNAME"] ||
    process.env["USER"] ||
    "unknown"
  );
}

function psBinary(): string {
  // Helix scripts are PowerShell. On Windows, `powershell` is always present.
  // On macOS/Linux, prefer `pwsh` (PowerShell 7+).
  return process.platform === "win32" ? "powershell" : "pwsh";
}

type HelixUiArea = "portfolio-planner" | "security-admin" | "integrations-admin" | "strategy-studio";

function parseUiArea(raw?: string): HelixUiArea {
  const v = String(raw ?? "").trim();
  switch (v) {
    case "portfolio-planner":
    case "security-admin":
    case "integrations-admin":
    case "strategy-studio":
      return v;
    default:
      return "strategy-studio";
  }
}

function defaultUiConceptId(surfaceTag: string, featureName: string): string {
  return `${slugify(surfaceTag)}-${slugify(featureName)}-v1`;
}

function podArtifactsDir(workspacePath: string, podId: string): string {
  return join(workspacePath, ".codex", "pods", safeFsName(podId));
}

function writeIfMissing(filePath: string, content: string): void {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, content, "utf-8");
}

type PodBoardItemStatus = "todo" | "doing" | "blocked" | "review" | "done";
type EvidenceGateStatus = "todo" | "pass" | "fail" | "waived";

function isoNow(): string {
  return new Date().toISOString();
}

function helixContractTemplate(args: {
  podId: string;
  featureName: string;
  surfaceTag: string;
  integrationBranch: string;
  defaultBranch: string;
  uiConceptId?: string | null;
  uiArea?: HelixUiArea | null;
}): string {
  const uiLine =
    args.uiConceptId && args.uiArea
      ? `UI concept: /dev/ui-concepts/${args.uiConceptId} (area: ${args.uiArea})`
      : "UI concept: TBD";

  return [
    `# Helix Feature Pod Contract`,
    ``,
    `Pod: ${args.podId}`,
    `Feature: ${args.featureName}`,
    `Surface: ${args.surfaceTag}`,
    `Integration branch: ${args.integrationBranch}`,
    `Target merge: ${args.integrationBranch} -> ${args.defaultBranch}`,
    uiLine,
    ``,
    `## Decision package (exec-grade)`,
    `Headline:`,
    `Why this matters:`,
    `Recommendation:`,
    `Options & tradeoffs:`,
    `Evidence / assumptions / data gaps:`,
    `Activation (explicit approval step):`,
    ``,
    `## Acceptance criteria (testable)`,
    `- [ ] Happy path works end-to-end`,
    `- [ ] Top failure paths are handled with exec-safe errors + remediation CTAs`,
    `- [ ] No silent side effects; activation is explicit and logged where applicable`,
    ``,
    `## Non-negotiable gates (no merge without these, unless founder waiver)`,
    `- [ ] Founder UX approval (screenshots + parity evidence attached)`,
    `- [ ] Playwright E2E: headless + headed for touched flows`,
    `- [ ] Playwright visual snapshots updated + passing for screenshot-locked frames`,
    `- [ ] Security: no known PII leaks; exports enforce authz (people:pii:read=false safe)`,
    `- [ ] Readiness & Data Quality reconcile (no contradictory gates)`,
    `- [ ] Deterministic numbers: reconcile OR show explicit Unknown + reason (no silent nulls)`,
    `- [ ] No raw JSON/stack traces rendered to execs`,
    `- [ ] Unit/integration tests added for new behavior`,
    `- [ ] Rollback plan + basic observability notes`,
    ``,
    `## UAT scenarios (scripted)`,
    `Known regression classes to explicitly cover (from recent Helix UAT):`,
    `- Exports: no PII leaks; encoding is correct (no mojibake)`,
    `- Readiness vs Data Quality: no contradictory gates/states`,
    `- Combined-org flows: no circular preconditions / dead ends`,
    `- Workforce grid: no 400/500 while UI claims READY`,
    `- AI-backed surfaces: never show raw JSON errors; handle 4xx/5xx with exec-safe UX`,
    `- Economics: no silent nulls; totals reconcile or show explicit Unknown`,
    ``,
    `- [ ] Scenario 1: ...`,
    `- [ ] Scenario 2: ...`,
    ``,
    `## Evidence pack (links / files / commands)`,
    `- Playwright report:`,
    `- Screenshots/video:`,
    `- Test commands executed + output:`,
    `- Notes on determinism / reconciliation checks:`,
    ``,
    `## Founder waivers (if any)`,
    `Record waivers explicitly: what gate is waived, why, risk, and owner.`,
    ``,
  ].join("\n");
}

function helixBoardTemplate(args: {
  podId: string;
  featureName: string;
  surfaceTag: string;
  integrationBranch: string;
  defaultBranch: string;
  uiConceptId: string | null;
  uiArea: HelixUiArea | null;
  workstreams: Array<{
    workItemId: string;
    title: string;
    ownerRole: string;
    status: PodBoardItemStatus;
    branch: string | null;
    pr: string | null;
    blocker: string | null;
    next: string | null;
  }>;
}): string {
  const doc = {
    version: 1,
    createdAt: isoNow(),
    podId: args.podId,
    featureName: args.featureName,
    surfaceTag: args.surfaceTag,
    integrationBranch: args.integrationBranch,
    defaultBranch: args.defaultBranch,
    ui: {
      enabled: Boolean(args.uiConceptId && args.uiArea),
      conceptId: args.uiConceptId,
      area: args.uiArea,
    },
    items: args.workstreams,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

function helixEvidenceTemplate(args: { podId: string; featureName: string; surfaceTag: string }): string {
  const gates: Array<{
    gateId: string;
    title: string;
    ownerRole: string;
    status: EvidenceGateStatus;
    evidence: Array<{ ts: string; byRole: string; kind: string; ref: string; notes?: string }>;
  }> = [
    {
      gateId: "ux_founder_approval",
      title: "Founder UX approval (screenshots + parity evidence attached)",
      ownerRole: "coordinator",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "playwright_e2e_headless",
      title: "Playwright E2E headless (touched flows)",
      ownerRole: "qa",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "playwright_e2e_headed",
      title: "Playwright E2E headed + evidence (screenshots/video)",
      ownerRole: "qa",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "security_pii_exports",
      title: "Security: exports enforce authz + no PII leaks when people:pii:read=false",
      ownerRole: "security",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "readiness_dq_reconcile",
      title: "Readiness & Data Quality reconcile (no contradictory gates/states)",
      ownerRole: "worker_data",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "deterministic_numbers",
      title: "Decision-grade numbers reconcile OR show explicit Unknown + reason (no silent nulls)",
      ownerRole: "worker_data",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "exec_safe_errors",
      title: "Exec-safe errors (no raw JSON/stack traces; remediation CTAs)",
      ownerRole: "worker_web",
      status: "todo",
      evidence: [],
    },
    {
      gateId: "tests_and_verification",
      title: "Required unit/integration tests + verification runs + artifacts captured",
      ownerRole: "verifier",
      status: "todo",
      evidence: [],
    },
  ];

  const doc = {
    version: 1,
    createdAt: isoNow(),
    podId: args.podId,
    featureName: args.featureName,
    surfaceTag: args.surfaceTag,
    gates,
    notes: "",
  };

  return JSON.stringify(doc, null, 2) + "\n";
}

function helixStatusTemplate(args: { podId: string; featureName: string; surfaceTag: string }): string {
  return [
    `# Pod status`,
    ``,
    `Pod: ${args.podId}`,
    `Feature: ${args.featureName}`,
    `Surface: ${args.surfaceTag}`,
    `As of: ${isoNow()}`,
    ``,
    `## Headline`,
    `TBD`,
    ``,
    `## Blockers`,
    `- None`,
    ``,
    `## Next`,
    `- Update BOARD.json owners + sequencing`,
    `- Collect worker status updates (JSONL) + evidence links`,
    ``,
  ].join("\n");
}

function helixPodProtocolTemplate(args: {
  podId: string;
  featureName: string;
  surfaceTag: string;
  integrationBranch: string;
  defaultBranch: string;
  uiConceptId: string | null;
  uiArea: HelixUiArea | null;
}): string {
  const baseRel = `.codex/pods/${safeFsName(args.podId)}`;
  const uiLine =
    args.uiConceptId && args.uiArea
      ? `UI concept: /dev/ui-concepts/${args.uiConceptId} (area: ${args.uiArea})`
      : "UI concept: TBD";

  return [
    `# Pod protocol (CTO-grade)`,
    ``,
    `Pod: ${args.podId}`,
    `Feature: ${args.featureName}`,
    `Surface: ${args.surfaceTag}`,
    `Integration branch: ${args.integrationBranch}`,
    `Target merge: ${args.integrationBranch} -> ${args.defaultBranch}`,
    uiLine,
    ``,
    `## Principles (non-negotiable)`,
    `- Coordinator is the hub. No peer-to-peer agent chat as a coordination mechanism.`,
    `- Files are the contract. State is communicated via artifacts under ${baseRel}/.`,
    `- Evidence before assertions. "Done" requires links to tests + screenshots + reproducible steps.`,
    `- No silent scope change. If requirements change, update CONTRACT.md and re-broadcast.`,
    ``,
    `## Required artifacts`,
    `- Contract (requirements + gates): ${baseRel}/CONTRACT.md`,
    `- Protocol (this file): ${baseRel}/PROTOCOL.md`,
    `- Board (assignments / sequencing): ${baseRel}/BOARD.json`,
    `- Evidence registry (ship/no-ship): ${baseRel}/evidence/EVIDENCE.json`,
    `- Exec status (headline + blockers + next): ${baseRel}/STATUS.md`,
    `- Status streams (append-only): ${baseRel}/status/<role>.jsonl`,
    ``,
    `## Ownership rules`,
    `- Coordinator edits: CONTRACT.md, BOARD.json, STATUS.md`,
    `- Each role appends only to: status/<role>.jsonl (append-only; do not rewrite old lines)`,
    `- Evidence gates: gate owners attach evidence; verifier/coordinator validates before signoff`,
    ``,
    `## Status update schema (JSONL)`,
    `One JSON object per line. Minimum fields:`,
    `- ts (ISO timestamp)`,
    `- role (string)`,
    `- state: todo|doing|blocked|review|done`,
    `- workItemId (string)`,
    `- summary (1 paragraph)`,
    `- testsRun (string[])`,
    `- evidencePaths (string[])`,
    `- blockers (string[])`,
    `- asks (string[])`,
    ``,
    `Update triggers (minimum): start work, when blocked, when opening PR, when producing evidence, when done.`,
    ``,
    `## Evidence expectations`,
    `A gate is not "pass" without evidence refs (paths/links). Typical evidence:`,
    `- Playwright report path`,
    `- Headed screenshots/video`,
    `- Test command output excerpts (or file refs)`,
    `- Notes on reconciliation/determinism checks (esp. economics)`,
    ``,
    `## Known regression classes to explicitly cover`,
    `- Exports: no PII leaks; encoding correct (no mojibake)`,
    `- Readiness vs Data Quality: no contradictory gates/states`,
    `- Combined-org flows: no circular preconditions / dead ends`,
    `- Workforce grid: no 400/500 while UI claims READY`,
    `- AI-backed surfaces: never show raw JSON errors; exec-safe remediation UX`,
    `- Economics: no silent nulls; totals reconcile OR show explicit Unknown + reason`,
    ``,
  ].join("\n");
}

function seedStatusJsonlIfMissing(filePath: string, seed: object): void {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, JSON.stringify(seed) + "\n", "utf-8");
}

async function bestEffortBootstrapHelixHandoff(
  workspacePath: string,
  owner: string,
  agentRole: string,
  surfaceTag: string,
): Promise<void> {
  const scriptRel = join(workspacePath, "scripts", "worktree-handoff.ps1");
  if (!existsSync(scriptRel)) return;

  try {
    await exec(
      psBinary(),
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptRel,
        "-Owner",
        owner,
        "-AgentRole",
        agentRole,
        "-SurfaceTag",
        surfaceTag,
        "-Force",
        "-Bootstrap",
      ],
      { cwd: workspacePath },
    );
  } catch {
    // Best effort: if PowerShell/gh/node aren't available, don't block the pod.
  }
}

async function bestEffortCommit(workspacePath: string, message: string, paths: string[]): Promise<void> {
  try {
    await exec("git", ["add", ...paths], { cwd: workspacePath });
    await exec("git", ["commit", "-m", message], { cwd: workspacePath });
  } catch {
    // Best effort — branch may already be clean or user may not want auto commits.
  }
}

function coordinatorPrompt(
  featureName: string,
  surfaceTag: string,
  integrationBranch: string,
  defaultBranch: string,
  podId: string,
  uiConceptId: string | null,
  uiArea: HelixUiArea,
): string {
  const contractRel = `.codex/pods/${safeFsName(podId)}/CONTRACT.md`;
  const boardRel = `.codex/pods/${safeFsName(podId)}/BOARD.json`;
  const protocolRel = `.codex/pods/${safeFsName(podId)}/PROTOCOL.md`;
  const evidenceRel = `.codex/pods/${safeFsName(podId)}/evidence/EVIDENCE.json`;
  const statusRel = `.codex/pods/${safeFsName(podId)}/status/coordinator.jsonl`;
  const uiLine = uiConceptId ? `/dev/ui-concepts/${uiConceptId} (area: ${uiArea})` : "TBD";
  return [
    `You are the Helix Feature Pod Lead (senior MBB partner + CTO).`,
    ``,
    `Feature: "${featureName}"`,
    `Surface: ${surfaceTag}`,
    `Integration branch: ${integrationBranch}`,
    `Pod: ${podId}`,
    `Contract: ${contractRel}`,
    `Board: ${boardRel}`,
    `Protocol: ${protocolRel}`,
    `Evidence: ${evidenceRel}`,
    `Status stream (you): ${statusRel}`,
    `Status stream (workers): .codex/pods/${safeFsName(podId)}/status/<role>.jsonl`,
    `UI concept: ${uiLine}`,
    ``,
    `Mission: ship a decision-grade, enterprise-ready feature with zero silent side effects.`,
    ``,
    `Required artifacts (create in the repo, keep them concise):`,
    `1. Update the contract (${contractRel}): decision package + acceptance criteria + gates.`,
    `2. Ensure UI/UX gate is satisfied: founder sees evidence (screenshots/video) and approves explicitly.`,
    `3. Ensure all gates are evidenced (tests + reproducible steps).`,
    `4. Contract checklist (block on violations):`,
    `   - Clean-room / PII redaction (no leaks when people:pii:read=false).`,
    `   - Readiness and Data Quality must reconcile (no contradictory gates).`,
    `   - Preconditions must be actionable (no circular dependencies / dead ends).`,
    `   - Exec-safe errors (never render raw JSON blobs).`,
    `   - Decision-grade numbers reconcile or show explicit Unknown + reason (no silent nulls).`,
    ``,
    `Working model:`,
    `- Workers open PRs targeting base branch ${integrationBranch} (not ${defaultBranch}).`,
    `- You keep the integration PR to ${defaultBranch} coherent, and you drive sign-off.`,
    `- Communication is hub-and-spoke: workers emit structured updates via JSONL; you summarize + assign via BOARD.json.`,
  ].join("\n");
}

function workerPrompt(
  role: string,
  roleName: string,
  ownership: string,
  featureName: string,
  surfaceTag: string,
  integrationBranch: string,
  defaultBranch: string,
  podId: string,
): string {
  const contractRel = `.codex/pods/${safeFsName(podId)}/CONTRACT.md`;
  const boardRel = `.codex/pods/${safeFsName(podId)}/BOARD.json`;
  const protocolRel = `.codex/pods/${safeFsName(podId)}/PROTOCOL.md`;
  const statusRel = `.codex/pods/${safeFsName(podId)}/status/${role}.jsonl`;

  const requiredSkills: string[] = [
    "test-driven-development (before implementing any behavior)",
    "systematic-debugging (when anything fails or is unclear)",
    "verification-before-completion (before claiming something is done/passing)",
  ];
  if (role === "qa" || role === "verifier") requiredSkills.push("webapp-testing (Playwright evidence/snapshots)");
  if (role === "security") requiredSkills.push("helix-security-issue-ticketing (when you find/clarify security defects)");
  if (role === "ui_concept") requiredSkills.push("helix-ui-concepts / helix-ui-concepts-docs (golden UI concept + viewer)");

  return [
    `You are the Helix ${roleName}.`,
    `Ownership boundary: ${ownership}`,
    ``,
    `Feature: "${featureName}"`,
    `Surface: ${surfaceTag}`,
    `Integration branch: ${integrationBranch}`,
    `Pod contract: ${contractRel}`,
    `Pod board (read-only): ${boardRel}`,
    `Pod protocol (read first): ${protocolRel}`,
    `Status stream (append-only): ${statusRel}`,
    ``,
    `Required skills (non-negotiable):`,
    ...requiredSkills.map((s) => `- ${s}`),
    ``,
    `Communication protocol (do NOT do peer-to-peer agent chat):`,
    `- Append a JSONL status update at start, when blocked, when opening PR, and when producing evidence.`,
    `- JSONL schema (one JSON object per line):`,
    `  - ts: ISO 8601 timestamp`,
    `  - role: "${role}"`,
    `  - state: todo|doing|blocked|review|done`,
    `  - workItemId: short stable id (e.g. web|api|data|security|qa|verify|ui|decision)`,
    `  - summary: one-paragraph update`,
    `  - testsRun: string[] (commands)`,
    `  - evidencePaths: string[] (paths/links to screenshots/reports/logs)`,
    `  - blockers: string[]`,
    `  - asks: string[] (what you need from coordinator/others)`,
    `Example JSONL line:`,
    `{"ts":"${isoNow()}","role":"${role}","state":"doing","workItemId":"<id>","summary":"...","testsRun":[],"evidencePaths":[],"blockers":[],"asks":[]}`,
    ``,
    `Non-negotiables:`,
    `- No silent side effects. Any behavior change must be described in PR.`,
    `- Never render raw JSON errors to users. Convert API failures into executive-safe guidance + remediation CTAs.`,
    `- No fake math: if inputs are missing, show Unknown + reason (never silently coerce to 0).`,
    `- Do NOT delete branches after merge unless explicitly instructed.`,
    ``,
    `PR rule: open your PR with base=${integrationBranch} (NOT ${defaultBranch}).`,
    `Suggested command: gh pr create --draft --base ${integrationBranch} --head <your-branch> --title \"${surfaceTag}: ${featureName}\"`,
    ``,
    `Sync rule: if you need other workstream changes, merge/rebase from origin/${integrationBranch}.`,
  ].join("\n");
}

async function setRoleMetadata(
  config: OrchestratorConfig,
  project: ProjectConfig,
  sessionId: string,
  role: string,
  podId: string,
  integrationBranch: string,
): Promise<void> {
  const sessionsDir = getSessionsDir(config.configPath, project.path);
  updateMetadata(sessionsDir, sessionId, {
    role,
    pod: podId,
    integrationBranch,
  });
}

export function registerPod(program: Command): void {
  const pod = program.command("pod").description("Helix-style feature pod helpers");

  pod
    .command("start")
    .description("Spawn a multi-agent feature pod (integration PR + role sessions)")
    .argument("<project>", "Project ID from config")
    .argument("<feature>", "Feature name (quote it if it contains spaces)")
    .requiredOption("--surface <tag>", "Helix surface tag (used for naming and handoff conventions)")
    .option("--ui", "Include a UI concept workstream (recommended for any UI changes)")
    .option("--ui-concept <id>", "UI concept id (defaults to <surface>-<feature>-v1 when --ui is set)")
    .option(
      "--ui-area <area>",
      "UI concept area (portfolio-planner | security-admin | integrations-admin | strategy-studio). Default: strategy-studio",
    )
    .option("--no-pr", "Do not attempt to auto-create the integration PR")
    .action(
      async (
        projectId: string,
        featureName: string,
        opts: {
          surface: string;
          ui?: boolean;
          uiConcept?: string;
          uiArea?: string;
          pr?: boolean;
        },
      ) => {
        const config = loadConfig();
        const project = config.projects[projectId];
        if (!project) {
          console.error(
            chalk.red(`Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`),
          );
          process.exit(1);
        }

        const surfaceTag = opts.surface.trim();
        const integrationBranch = makeIntegrationBranch(surfaceTag, featureName);
        const podId = `${new Date().toISOString().slice(0, 10)}:${surfaceTag}:${slugify(featureName)}`;
        const uiArea = parseUiArea(opts.uiArea);
        const uiConceptId =
          opts.ui === true ? (opts.uiConcept?.trim() ? opts.uiConcept.trim() : defaultUiConceptId(surfaceTag, featureName)) : null;

        const spinner = ora("Spawning feature pod").start();
        const sm = await getSessionManager(config);

        // 1) Integration (coordinator) session
        spinner.text = "Creating integration (coordinator) session";
        const coordinator = await sm.spawn({
          projectId,
          branch: integrationBranch,
          prompt: "Pod setup in progress. Stand by for instructions.",
        });
        await setRoleMetadata(config, project, coordinator.id, "coordinator", podId, integrationBranch);

        let integrationPrUrl: string | null = null;
        if (coordinator.workspacePath) {
          // Helix: bootstrap handoff file first (best effort), so the PR starts with required breadcrumbs.
          spinner.text = "Bootstrapping Helix handoff (best effort)";
          await bestEffortBootstrapHelixHandoff(
            coordinator.workspacePath,
            defaultOwner(),
            "coordinator",
            surfaceTag,
          );

          // Fill Goal/Now/Next so Helix preflight can pass once PR URL is written.
          const handoffPath = handoffFilePath(coordinator.workspacePath, integrationBranch);
          if (existsSync(handoffPath)) {
            const raw = readFileSync(handoffPath, "utf-8");
            const updated = updateHandoffMarkdown(raw, {
              goal: `Ship "${featureName}" (pod: ${podId})`,
              now: "Pod spawned; coordinating workstreams",
              next: "Land worker PRs into integration branch; run CI + UAT gates",
            });
            writeFileSync(handoffPath, updated, "utf-8");
            await bestEffortCommit(coordinator.workspacePath, "chore: worktree handoff", [
              `.codex/worktrees/${sanitizeForHandoffFileName(integrationBranch)}.md`,
            ]);
          }

          // Create pod contract skeleton on the integration branch (best effort).
          const podDir = podArtifactsDir(coordinator.workspacePath, podId);
          mkdirSync(podDir, { recursive: true });

          const contractPath = join(podDir, "CONTRACT.md");
          writeIfMissing(
            contractPath,
            helixContractTemplate({
              podId,
              featureName,
              surfaceTag,
              integrationBranch,
              defaultBranch: project.defaultBranch,
              uiConceptId,
              uiArea: opts.ui === true ? uiArea : null,
            }),
          );
          await bestEffortCommit(coordinator.workspacePath, "chore: seed pod contract", [
            `.codex/pods/${safeFsName(podId)}/CONTRACT.md`,
          ]);
        }

        if (opts.pr !== false && coordinator.workspacePath) {
          spinner.text = "Creating integration PR (best effort)";
          try {
            const prTitle = `${surfaceTag}: ${featureName}`;
            const prBody = [
              `Integration PR for feature pod: ${podId}`,
              ``,
              `- Feature: ${featureName}`,
              `- Surface: ${surfaceTag}`,
              `- Integration branch: ${integrationBranch}`,
              ``,
              `Workers should open PRs against base branch ${integrationBranch}.`,
            ].join("\n");
            integrationPrUrl = await bestEffortCreateDraftPr(
              project,
              coordinator.workspacePath,
              integrationBranch,
              project.defaultBranch,
              prTitle,
              prBody,
            );
            if (integrationPrUrl) {
              // Update Helix handoff file with PR URL (best effort)
              const hp = handoffFilePath(coordinator.workspacePath, integrationBranch);
              if (existsSync(hp)) {
                const raw = readFileSync(hp, "utf-8");
                writeFileSync(
                  hp,
                  updateHandoffMarkdown(raw, { prUrl: integrationPrUrl }),
                  "utf-8",
                );
                await bestEffortCommit(coordinator.workspacePath, "chore: link PR in handoff", [
                  `.codex/worktrees/${sanitizeForHandoffFileName(integrationBranch)}.md`,
                ]);
                await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: coordinator.workspacePath });
              }

              const sessionsDir = getSessionsDir(config.configPath, project.path);
              updateMetadata(sessionsDir, coordinator.id, {
                pr: integrationPrUrl,
                status: "pr_open",
              });
            }
          } catch (err) {
            // Best-effort: keep going — user can create PR manually.
            integrationPrUrl = null;
          }
        }

        // 2) Worker sessions
        const roles: Array<{
          role: string;
          roleName: string;
          branchSuffix: string;
          ownership: string;
          agent?: string;
        }> = [
          {
            role: "decision_guardian",
            roleName: "Decision Guardian (MBB partner)",
            branchSuffix: "decision",
            ownership: "decision package, acceptance criteria, exec narrative, and governance language",
          },
          ...(opts.ui === true
            ? [
                {
                  role: "ui_concept",
                  roleName: "UI Concepts Lead",
                  branchSuffix: "concept",
                  ownership:
                    "golden UI concept + viewer registration + screenshot-gated handoff (docs/ui-concepts + ui-golden + registry)",
                  agent: "claude-code",
                },
              ]
            : []),
          {
            role: "worker_web",
            roleName: "Frontend Lead",
            branchSuffix: "web",
            ownership: "`apps/web`, `packages/ui`, and related web tests",
          },
          {
            role: "worker_api",
            roleName: "Backend Lead",
            branchSuffix: "api",
            ownership: "`apps/api`, GraphQL/API contracts, and related API tests",
          },
          {
            role: "worker_data",
            roleName: "Data/Math Lead",
            branchSuffix: "data",
            ownership: "data quality/readiness invariants, economics reconciliation, and related tests",
          },
          {
            role: "security",
            roleName: "Security Lead",
            branchSuffix: "security",
            ownership: "authz, PII controls, export safety, and secure defaults (no leaks)",
          },
          {
            role: "qa",
            roleName: "QA Automation Lead",
            branchSuffix: "qa",
            ownership: "Playwright E2E + UAT scripts, regression coverage for known defect classes",
          },
          {
            role: "verifier",
            roleName: "Verifier",
            branchSuffix: "verify",
            ownership: "run required test commands, capture evidence, and block until gates are green",
          },
        ];

        // Seed pod comms artifacts in the coordinator workspace (best effort).
        if (coordinator.workspacePath) {
          const podDir = podArtifactsDir(coordinator.workspacePath, podId);
          const evidenceDir = join(podDir, "evidence");
          const statusDir = join(podDir, "status");
          mkdirSync(evidenceDir, { recursive: true });
          mkdirSync(statusDir, { recursive: true });

          const workstreams = roles.map((r) => ({
            workItemId: r.role,
            title: r.roleName,
            ownerRole: r.role,
            status: "todo" as const,
            branch: makeRoleBranch(integrationBranch, r.branchSuffix),
            pr: null,
            blocker: null,
            next: `Open a draft PR into ${integrationBranch}`,
          }));

          writeIfMissing(
            join(podDir, "BOARD.json"),
            helixBoardTemplate({
              podId,
              featureName,
              surfaceTag,
              integrationBranch,
              defaultBranch: project.defaultBranch,
              uiConceptId,
              uiArea: opts.ui === true ? uiArea : null,
              workstreams,
            }),
          );

          writeIfMissing(join(evidenceDir, "EVIDENCE.json"), helixEvidenceTemplate({ podId, featureName, surfaceTag }));
          writeIfMissing(join(podDir, "STATUS.md"), helixStatusTemplate({ podId, featureName, surfaceTag }));
          writeIfMissing(
            join(podDir, "PROTOCOL.md"),
            helixPodProtocolTemplate({
              podId,
              featureName,
              surfaceTag,
              integrationBranch,
              defaultBranch: project.defaultBranch,
              uiConceptId,
              uiArea: opts.ui === true ? uiArea : null,
            }),
          );
          seedStatusJsonlIfMissing(join(statusDir, "coordinator.jsonl"), {
            ts: isoNow(),
            role: "coordinator",
            state: "doing",
            workItemId: "coord",
            summary: "Pod spawned; awaiting worker briefs and PRs",
            testsRun: [],
            evidencePaths: [],
            blockers: [],
            asks: [],
          });

          await bestEffortCommit(coordinator.workspacePath, "chore: seed pod comms artifacts", [
            `.codex/pods/${safeFsName(podId)}/BOARD.json`,
            `.codex/pods/${safeFsName(podId)}/STATUS.md`,
            `.codex/pods/${safeFsName(podId)}/PROTOCOL.md`,
            `.codex/pods/${safeFsName(podId)}/status/coordinator.jsonl`,
            `.codex/pods/${safeFsName(podId)}/evidence/EVIDENCE.json`,
          ]);
        }

        const spawned: Array<{ role: string; sessionId: string; branch: string | null; worktree: string | null }> =
          [];

        for (const r of roles) {
          const branch = makeRoleBranch(integrationBranch, r.branchSuffix);
          spinner.text = `Spawning ${r.role} session`;
          const s = await sm.spawn({
            projectId,
            branch,
            agent: r.agent,
            prompt: "Pod setup in progress. Stand by for instructions.",
          });
          await setRoleMetadata(config, project, s.id, r.role, podId, integrationBranch);
          spawned.push({ role: r.role, sessionId: s.id, branch: s.branch, worktree: s.workspacePath });

          // Seed worker status stream file (not committed; used for cross-session visibility via `ao pod status --updates`).
          if (s.workspacePath) {
            const podDir = podArtifactsDir(s.workspacePath, podId);
            const statusDir = join(podDir, "status");
            mkdirSync(statusDir, { recursive: true });
            seedStatusJsonlIfMissing(join(statusDir, `${r.role}.jsonl`), {
              ts: isoNow(),
              role: r.role,
              state: "todo",
              workItemId: r.role,
              summary: "Pod spawned; awaiting brief",
              testsRun: [],
              evidencePaths: [],
              blockers: [],
              asks: [],
            });
          }

          // Helix handoff + draft PR for each worker (best effort)
          if (opts.pr !== false && s.workspacePath) {
            spinner.text = `Bootstrapping ${r.role} handoff + PR (best effort)`;
            await bestEffortBootstrapHelixHandoff(s.workspacePath, defaultOwner(), r.role, surfaceTag);

            const hp = handoffFilePath(s.workspacePath, branch);
            if (existsSync(hp)) {
              const raw = readFileSync(hp, "utf-8");
              writeFileSync(
                hp,
                updateHandoffMarkdown(raw, {
                  goal: `Implement "${featureName}" (${r.role}) (pod: ${podId})`,
                  now: "Pod spawned; awaiting task brief",
                  next: `Implement workstream and open PR into ${integrationBranch}`,
                }),
                "utf-8",
              );
              await bestEffortCommit(s.workspacePath, "chore: worktree handoff", [
                `.codex/worktrees/${sanitizeForHandoffFileName(branch)}.md`,
              ]);
            }

            try {
              const prTitle = `${surfaceTag}: ${featureName} (${r.role})`;
              const prBody = [
                `Workstream PR for pod: ${podId}`,
                ``,
                `- Role: ${r.role}`,
                `- Feature: ${featureName}`,
                `- Surface: ${surfaceTag}`,
                `- Base (integration): ${integrationBranch}`,
              ].join("\n");
              const prUrl = await bestEffortCreateDraftPr(
                project,
                s.workspacePath,
                branch,
                integrationBranch,
                prTitle,
                prBody,
              );

              if (prUrl) {
                const raw = existsSync(hp) ? readFileSync(hp, "utf-8") : "";
                if (raw) {
                  writeFileSync(hp, updateHandoffMarkdown(raw, { prUrl }), "utf-8");
                  await bestEffortCommit(s.workspacePath, "chore: link PR in handoff", [
                    `.codex/worktrees/${sanitizeForHandoffFileName(branch)}.md`,
                  ]);
                  await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: s.workspacePath });
                }

                const sessionsDir = getSessionsDir(config.configPath, project.path);
                updateMetadata(sessionsDir, s.id, { pr: prUrl, status: "pr_open" });
              }
            } catch {
              // Non-fatal: user can create PRs manually.
            }
          }
        }

        // Now that PRs/handoffs are created, send role instructions.
        try {
          spinner.text = "Sending role briefs";
          await sm.send(
            coordinator.id,
            coordinatorPrompt(
              featureName,
              surfaceTag,
              integrationBranch,
              project.defaultBranch,
              podId,
              uiConceptId,
              uiArea,
            ),
          );
          for (const r of roles) {
            const target = spawned.find((x) => x.role === r.role);
            if (!target) continue;
            await sm.send(
              target.sessionId,
              workerPrompt(
                r.role,
                r.roleName,
                r.ownership,
                featureName,
                surfaceTag,
                integrationBranch,
                project.defaultBranch,
                podId,
              ),
            );
          }

          // Post-brief: give the UI concepts lead the concrete concept id + viewer link, if enabled.
          if (opts.ui === true && uiConceptId) {
            const uiSession = spawned.find((x) => x.role === "ui_concept");
            if (uiSession) {
              await sm.send(
                uiSession.sessionId,
                [
                  `UI concept id: ${uiConceptId}`,
                  `UI area: ${uiArea}`,
                  ``,
                  `Target: create + register the concept so it renders in the local viewer:`,
                  `- /dev/ui-concepts/${uiConceptId}`,
                  `- /dev/ui-concepts/render/${uiConceptId}`,
                  ``,
                  `Required skill: helix-ui-concepts (and/or helix-ui-concepts-docs).`,
                ].join("\n"),
              );
            }
          }
        } catch {
          // Non-fatal: user can message sessions manually.
        }

        spinner.succeed("Pod spawned");

        console.log(chalk.bold("\nPod summary"));
        console.log(`  Pod:        ${chalk.cyan(podId)}`);
        console.log(`  Project:    ${chalk.cyan(projectId)} (${project.repo})`);
        console.log(`  Surface:    ${chalk.cyan(surfaceTag)}`);
        console.log(`  Integrate:  ${chalk.cyan(integrationBranch)}`);
        console.log(`  Coord:      ${chalk.green(coordinator.id)}  ${chalk.dim(coordinator.workspacePath ?? "-")}`);
        if (integrationPrUrl) {
          console.log(`  PR:         ${chalk.blue(integrationPrUrl)}`);
        } else if (opts.pr !== false) {
          console.log(
            `  PR:         ${chalk.yellow("not created automatically")} (create a draft PR from ${integrationBranch} -> ${project.defaultBranch})`,
          );
        }

        console.log(chalk.bold("\nWorker sessions"));
        for (const s of spawned) {
          console.log(
            `  ${chalk.green(s.sessionId)}  ${chalk.dim(s.role)}  ${chalk.cyan(s.branch ?? "-")}  ${chalk.dim(s.worktree ?? "-")}`,
          );
        }
        console.log();
      },
    );

  pod
    .command("status")
    .description("Show all sessions belonging to a pod id")
    .argument("<project>", "Project ID from config")
    .argument("<pod>", "Pod id (exact string printed by `ao pod start`)")
    .option("--updates", "Show latest JSONL status updates from each session workspace")
    .option("--tail <n>", "Lines per role when showing updates (default: 3)", "3")
    .option("--board", "Show BOARD.json from the coordinator workspace (if present)")
    .option("--evidence", "Show evidence gate summary from EVIDENCE.json (if present)")
    .action(async (projectId: string, podId: string, opts: { updates?: boolean; tail?: string; board?: boolean; evidence?: boolean }) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(projectId);
      const matches = sessions.filter((s) => s.metadata?.["pod"] === podId);

      if (matches.length === 0) {
        console.log(chalk.yellow(`No sessions found for pod: ${podId}`));
        return;
      }

      console.log(chalk.bold(`Pod: ${podId}`));
      for (const s of matches) {
        const role = s.metadata?.["role"] ?? "unknown";
        const pr = s.metadata?.["pr"] ?? "-";
        const branch = s.branch ?? "-";
        const wt = s.workspacePath ?? "-";
        console.log(`  ${chalk.green(s.id)}  ${chalk.dim(role)}  ${chalk.cyan(branch)}  ${chalk.dim(wt)}  ${chalk.blue(pr)}`);
      }

      const coordinator = matches.find((s) => s.metadata?.["role"] === "coordinator");
      const coordinatorPodDir = coordinator?.workspacePath ? podArtifactsDir(coordinator.workspacePath, podId) : null;
      const showUpdates = opts.updates === true;
      const tail = Math.max(1, Number.parseInt(String(opts.tail ?? "3"), 10) || 3);

      if (opts.board === true && coordinatorPodDir) {
        const boardPath = join(coordinatorPodDir, "BOARD.json");
        console.log(chalk.bold("\nBoard"));
        if (!existsSync(boardPath)) {
          console.log(chalk.yellow(`  not found: ${boardPath}`));
        } else {
          try {
            const board = JSON.parse(readFileSync(boardPath, "utf-8")) as {
              items?: Array<{ workItemId?: string; title?: string; ownerRole?: string; status?: string; pr?: string | null; blocker?: string | null }>;
            };
            for (const it of board.items ?? []) {
              const id = it.workItemId ?? "-";
              const st = it.status ?? "-";
              const owner = it.ownerRole ?? "-";
              const title = it.title ?? "-";
              const pr = it.pr ? ` ${chalk.blue(it.pr)}` : "";
              const blocker = it.blocker ? ` ${chalk.red(`BLOCKED: ${it.blocker}`)}` : "";
              console.log(`  ${chalk.cyan(id)}  ${chalk.dim(st)}  ${chalk.dim(owner)}  ${title}${pr}${blocker}`);
            }
          } catch {
            console.log(chalk.yellow(`  failed to parse; raw file: ${boardPath}`));
          }
        }
      }

      if (opts.evidence === true && coordinatorPodDir) {
        const evidencePath = join(coordinatorPodDir, "evidence", "EVIDENCE.json");
        console.log(chalk.bold("\nEvidence gates"));
        if (!existsSync(evidencePath)) {
          console.log(chalk.yellow(`  not found: ${evidencePath}`));
        } else {
          try {
            const ev = JSON.parse(readFileSync(evidencePath, "utf-8")) as {
              gates?: Array<{ gateId?: string; title?: string; ownerRole?: string; status?: string }>;
            };
            for (const g of ev.gates ?? []) {
              const id = g.gateId ?? "-";
              const st = g.status ?? "-";
              const owner = g.ownerRole ?? "-";
              const title = g.title ?? "-";
              console.log(`  ${chalk.cyan(id)}  ${chalk.dim(st)}  ${chalk.dim(owner)}  ${title}`);
            }
          } catch {
            console.log(chalk.yellow(`  failed to parse; raw file: ${evidencePath}`));
          }
        }
      }

      if (showUpdates) {
        console.log(chalk.bold(`\nLatest updates (tail=${tail})`));
        for (const s of matches) {
          const role = s.metadata?.["role"] ?? "unknown";
          if (!s.workspacePath) continue;
          const statusPath = join(s.workspacePath, ".codex", "pods", safeFsName(podId), "status", `${role}.jsonl`);
          console.log(chalk.bold(`\n${role}  ${chalk.dim(statusPath)}`));
          if (!existsSync(statusPath)) {
            console.log(chalk.yellow("  (no status file)"));
            continue;
          }
          try {
            const raw = readFileSync(statusPath, "utf-8");
            const lines = raw
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean);
            const slice = lines.slice(Math.max(0, lines.length - tail));
            for (const line of slice) {
              console.log(`  ${line}`);
            }
          } catch {
            console.log(chalk.yellow("  (failed to read)"));
          }
        }
      }
    });

  pod
    .command("sync")
    .description("Rebroadcast the pod contract to all sessions (use after you edit requirements)")
    .argument("<project>", "Project ID from config")
    .argument("<pod>", "Pod id (exact string printed by `ao pod start`)")
    .action(async (projectId: string, podId: string) => {
      const config = loadConfig();
      const project = config.projects[projectId];
      if (!project) {
        console.error(chalk.red(`Unknown project: ${projectId}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const sessions = await sm.list(projectId);
      const matches = sessions.filter((s) => s.metadata?.["pod"] === podId);

      const coordinator = matches.find((s) => s.metadata?.["role"] === "coordinator");
      if (!coordinator?.workspacePath) {
        console.error(chalk.red(`Could not find coordinator workspace for pod: ${podId}`));
        process.exit(1);
      }

      const contractPath = join(
        coordinator.workspacePath,
        ".codex",
        "pods",
        safeFsName(podId),
        "CONTRACT.md",
      );
      if (!existsSync(contractPath)) {
        console.error(chalk.red(`Contract not found: ${contractPath}`));
        process.exit(1);
      }

      const contract = readFileSync(contractPath, "utf-8");
      const message = [
        `POD CONTRACT UPDATE (source of truth):`,
        `- Pod: ${podId}`,
        `- Contract: .codex/pods/${safeFsName(podId)}/CONTRACT.md`,
        `- Protocol: .codex/pods/${safeFsName(podId)}/PROTOCOL.md`,
        `- Board: .codex/pods/${safeFsName(podId)}/BOARD.json`,
        `- Evidence: .codex/pods/${safeFsName(podId)}/evidence/EVIDENCE.json`,
        `- Status updates: .codex/pods/${safeFsName(podId)}/status/<role>.jsonl`,
        ``,
        contract,
      ].join("\n");

      const spinner = ora(`Syncing contract to ${matches.length} session(s)`).start();
      for (const s of matches) {
        try {
          await sm.send(s.id, message);
        } catch {
          // Best effort: keep going.
        }
      }
      spinner.succeed("Contract synced");
    });
}
