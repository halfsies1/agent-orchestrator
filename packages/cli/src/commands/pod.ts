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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
): string {
  return [
    `You are the Helix Feature Pod Lead (senior MBB partner + CTO).`,
    ``,
    `Feature: "${featureName}"`,
    `Surface: ${surfaceTag}`,
    `Integration branch: ${integrationBranch}`,
    ``,
    `Mission: ship a decision-grade, enterprise-ready feature with zero silent side effects.`,
    ``,
    `Required artifacts (create in the repo, keep them concise):`,
    `1. Decision package draft: Headline -> Why This Matters -> Recommendation -> Options/Tradeoffs -> Evidence/Assumptions/Data gaps -> Activation.`,
    `2. Acceptance criteria: explicit and testable (happy path + top failure paths).`,
    `3. Contract checklist:`,
    `   - Clean-room / PII redaction (no leaks when people:pii:read=false).`,
    `   - Readiness and Data Quality must reconcile (no contradictory gates).`,
    `   - Preconditions must be actionable (no circular dependencies / dead ends).`,
    `   - Exec-safe errors (never render raw JSON blobs).`,
    `   - Decision-grade numbers reconcile or show explicit Unknown + reason (no silent nulls).`,
    ``,
    `Working model:`,
    `- Workers open PRs targeting base branch ${integrationBranch} (not ${defaultBranch}).`,
    `- You keep the integration PR to ${defaultBranch} coherent, and you drive sign-off.`,
  ].join("\n");
}

function workerPrompt(
  roleName: string,
  ownership: string,
  featureName: string,
  surfaceTag: string,
  integrationBranch: string,
  defaultBranch: string,
): string {
  return [
    `You are the Helix ${roleName}.`,
    `Ownership boundary: ${ownership}`,
    ``,
    `Feature: "${featureName}"`,
    `Surface: ${surfaceTag}`,
    `Integration branch: ${integrationBranch}`,
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
    .option("--no-pr", "Do not attempt to auto-create the integration PR")
    .action(
      async (
        projectId: string,
        featureName: string,
        opts: {
          surface: string;
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
        }> = [
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
            role: "qa",
            roleName: "QA Automation Lead",
            branchSuffix: "qa",
            ownership: "Playwright E2E + UAT scripts, regression coverage for known defect classes",
          },
        ];

        const spawned: Array<{ role: string; sessionId: string; branch: string | null; worktree: string | null }> =
          [];

        for (const r of roles) {
          const branch = makeRoleBranch(integrationBranch, r.branchSuffix);
          spinner.text = `Spawning ${r.role} session`;
          const s = await sm.spawn({
            projectId,
            branch,
            prompt: "Pod setup in progress. Stand by for instructions.",
          });
          await setRoleMetadata(config, project, s.id, r.role, podId, integrationBranch);
          spawned.push({ role: r.role, sessionId: s.id, branch: s.branch, worktree: s.workspacePath });

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
            coordinatorPrompt(featureName, surfaceTag, integrationBranch, project.defaultBranch),
          );
          for (const r of roles) {
            const target = spawned.find((x) => x.role === r.role);
            if (!target) continue;
            await sm.send(
              target.sessionId,
              workerPrompt(
                r.roleName,
                r.ownership,
                featureName,
                surfaceTag,
                integrationBranch,
                project.defaultBranch,
              ),
            );
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
}
