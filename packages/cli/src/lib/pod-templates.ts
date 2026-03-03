import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { parse as yamlParse } from "yaml";

export type PodTemplateRole = {
  role: string;
  roleName: string;
  branchSuffix: string;
  ownership: string;
  agent?: string;
  /**
   * If true, only include when the pod is started with `--ui`.
   * Use this for UI concept workstreams or UI-only gates.
   */
  requiresUi?: boolean;
};

export type PodTemplateGate = {
  gateId: string;
  title: string;
  ownerRole: string;
  /** If true, only include when the pod is started with `--ui`. */
  requiresUi?: boolean;
};

export type PodTemplate = {
  name: string;
  description: string;
  /** Roles spawned as separate sessions. (Coordinator is implicit; do not include it here.) */
  roles: PodTemplateRole[];
  /** Evidence gates seeded in `.codex/pods/<podId>/evidence/EVIDENCE.json`. */
  gates: PodTemplateGate[];
};

const HELIX_TEMPLATE: PodTemplate = {
  name: "helix",
  description: "Helix decision-grade pod (MBB partner + CTO + specialists + QA/security + verifier)",
  roles: [
    {
      role: "decision_guardian",
      roleName: "Decision Guardian (MBB partner)",
      branchSuffix: "decision",
      ownership: "decision package, acceptance criteria, exec narrative, and governance language",
    },
    {
      role: "ui_concept",
      roleName: "UI Concepts Lead",
      branchSuffix: "concept",
      ownership: "golden UI concept + viewer registration + screenshot-gated handoff (docs/ui-concepts + ui-golden + registry)",
      agent: "claude-code",
      requiresUi: true,
    },
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
  ],
  gates: [
    {
      gateId: "ux_founder_approval",
      title: "Founder UX approval (screenshots + parity evidence attached)",
      ownerRole: "coordinator",
      requiresUi: true,
    },
    {
      gateId: "playwright_e2e_headless",
      title: "Playwright E2E headless (touched flows)",
      ownerRole: "qa",
    },
    {
      gateId: "playwright_e2e_headed",
      title: "Playwright E2E headed + evidence (screenshots/video)",
      ownerRole: "qa",
      requiresUi: true,
    },
    {
      gateId: "security_pii_exports",
      title: "Security: exports enforce authz + no PII leaks when people:pii:read=false",
      ownerRole: "security",
    },
    {
      gateId: "readiness_dq_reconcile",
      title: "Readiness & Data Quality reconcile (no contradictory gates/states)",
      ownerRole: "worker_data",
    },
    {
      gateId: "deterministic_numbers",
      title: "Decision-grade numbers reconcile OR show explicit Unknown + reason (no silent nulls)",
      ownerRole: "worker_data",
    },
    {
      gateId: "exec_safe_errors",
      title: "Exec-safe errors (no raw JSON/stack traces; remediation CTAs)",
      ownerRole: "worker_web",
    },
    {
      gateId: "tests_and_verification",
      title: "Required unit/integration tests + verification runs + artifacts captured",
      ownerRole: "verifier",
    },
  ],
};

const MINIMAL_TEMPLATE: PodTemplate = {
  name: "minimal",
  description: "Minimal pod (worker + verifier; generic across repos)",
  roles: [
    {
      role: "worker",
      roleName: "Implementation Lead",
      branchSuffix: "work",
      ownership: "end-to-end implementation (code + tests) for the feature",
    },
    {
      role: "verifier",
      roleName: "Verifier",
      branchSuffix: "verify",
      ownership: "run required tests/verification, capture evidence, ship/no-ship gate",
    },
  ],
  gates: [
    {
      gateId: "tests_and_verification",
      title: "Required tests + verification evidence",
      ownerRole: "verifier",
    },
  ],
};

export const BUILTIN_POD_TEMPLATES: Record<string, PodTemplate> = {
  helix: HELIX_TEMPLATE,
  minimal: MINIMAL_TEMPLATE,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Template field "${key}" must be a non-empty string`);
  }
  return v.trim();
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`Template field "${key}" must be a string if provided`);
  const s = v.trim();
  return s ? s : undefined;
}

function optBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`Template field "${key}" must be a boolean if provided`);
  return v;
}

function validatePodTemplate(raw: unknown, args: { fallbackName: string }): PodTemplate {
  if (!isRecord(raw)) throw new Error("Template must be a YAML/JSON object");

  const name = optString(raw, "name") ?? args.fallbackName;
  const description = optString(raw, "description") ?? "";

  const rolesRaw = raw["roles"];
  if (!Array.isArray(rolesRaw)) throw new Error('Template field "roles" must be an array');

  const roles: PodTemplateRole[] = rolesRaw.map((r, i) => {
    if (!isRecord(r)) throw new Error(`Template role at index ${i} must be an object`);
    const role = reqString(r, "role");
    if (role === "coordinator") {
      throw new Error('Template role "coordinator" is implicit; do not include it in roles[]');
    }
    return {
      role,
      roleName: reqString(r, "roleName"),
      branchSuffix: reqString(r, "branchSuffix"),
      ownership: reqString(r, "ownership"),
      agent: optString(r, "agent"),
      requiresUi: optBool(r, "requiresUi"),
    };
  });

  const uniqueRoles = new Set<string>();
  for (const r of roles) {
    if (uniqueRoles.has(r.role)) throw new Error(`Template roles contain duplicate role: "${r.role}"`);
    uniqueRoles.add(r.role);
  }

  const gatesRaw = raw["gates"];
  if (!Array.isArray(gatesRaw)) throw new Error('Template field "gates" must be an array');

  const gates: PodTemplateGate[] = gatesRaw.map((g, i) => {
    if (!isRecord(g)) throw new Error(`Template gate at index ${i} must be an object`);
    return {
      gateId: reqString(g, "gateId"),
      title: reqString(g, "title"),
      ownerRole: reqString(g, "ownerRole"),
      requiresUi: optBool(g, "requiresUi"),
    };
  });

  const uniqueGates = new Set<string>();
  for (const g of gates) {
    if (uniqueGates.has(g.gateId)) throw new Error(`Template gates contain duplicate gateId: "${g.gateId}"`);
    uniqueGates.add(g.gateId);
  }

  if (roles.length === 0) throw new Error("Template must define at least 1 role");
  if (gates.length === 0) throw new Error("Template must define at least 1 gate");

  return { name, description, roles, gates };
}

export function loadPodTemplate(templateArg: string | undefined, repoRoot: string): PodTemplate {
  const key = (templateArg ?? "helix").trim() || "helix";

  const builtin = BUILTIN_POD_TEMPLATES[key];
  if (builtin) return builtin;

  const resolved = resolve(repoRoot, key);
  if (!existsSync(resolved)) {
    const known = Object.keys(BUILTIN_POD_TEMPLATES).sort().join(", ");
    throw new Error(`Unknown template "${key}". Use a built-in (${known}) or pass a yaml/json file path. Not found: ${resolved}`);
  }

  const rawText = readFileSync(resolved, "utf-8");
  const parsed =
    extname(resolved).toLowerCase() === ".json" ? (JSON.parse(rawText) as unknown) : (yamlParse(rawText) as unknown);

  return validatePodTemplate(parsed, { fallbackName: basename(resolved) });
}

export function materializePodRoles(template: PodTemplate, opts: { uiEnabled: boolean }): PodTemplateRole[] {
  const uiEnabled = opts.uiEnabled === true;
  return template.roles.filter((r) => uiEnabled || r.requiresUi !== true);
}

export function materializePodGates(template: PodTemplate, opts: { uiEnabled: boolean }): PodTemplateGate[] {
  const uiEnabled = opts.uiEnabled === true;
  return template.gates.filter((g) => uiEnabled || g.requiresUi !== true);
}

