import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPodTemplate, materializePodGates, materializePodRoles } from "../../src/lib/pod-templates.js";

describe("pod templates", () => {
  it("loads builtin helix by default", () => {
    const t = loadPodTemplate(undefined, process.cwd());
    expect(t.name).toBe("helix");
    expect(t.roles.length).toBeGreaterThan(0);
    expect(t.gates.length).toBeGreaterThan(0);
  });

  it("filters ui-only roles and gates when ui is disabled", () => {
    const t = loadPodTemplate("helix", process.cwd());
    const roles = materializePodRoles(t, { uiEnabled: false });
    const gates = materializePodGates(t, { uiEnabled: false });

    expect(roles.some((r) => r.role === "ui_concept")).toBe(false);
    expect(gates.some((g) => g.gateId === "ux_founder_approval")).toBe(false);
  });

  it("loads a yaml template from a file path relative to repoRoot", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-pod-template-"));
    try {
      const yamlPath = join(dir, "template.yaml");
      writeFileSync(
        yamlPath,
        [
          "name: tiny",
          "description: tiny template",
          "roles:",
          "  - role: worker",
          "    roleName: Worker",
          "    branchSuffix: work",
          "    ownership: impl",
          "gates:",
          "  - gateId: tests",
          "    title: Tests",
          "    ownerRole: verifier",
          "",
        ].join("\n"),
        "utf-8",
      );

      const t = loadPodTemplate("template.yaml", dir);
      expect(t.name).toBe("tiny");
      expect(t.roles[0]?.role).toBe("worker");
      expect(t.gates[0]?.gateId).toBe("tests");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

