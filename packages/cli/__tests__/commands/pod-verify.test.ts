import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerPod } from "../../src/commands/pod.js";

let tmpDir: string;
let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

function seedPodRepo(repoRoot: string, podId: string, args: { done: boolean; gatesPass: boolean; gateEvidence: boolean }): void {
  const podDir = join(repoRoot, ".codex", "pods", podId);
  mkdirSync(join(podDir, "evidence"), { recursive: true });

  writeFileSync(join(podDir, "PROTOCOL.md"), "# protocol\n", "utf-8");
  writeFileSync(join(podDir, "CONTRACT.md"), "# contract\n", "utf-8");

  const board = {
    version: 1,
    podId,
    items: [
      {
        workItemId: "worker_web",
        title: "Frontend Lead",
        ownerRole: "worker_web",
        status: args.done ? "done" : "todo",
        branch: "feat/x-web",
        pr: null,
        blocker: null,
        next: null,
      },
    ],
  };
  writeFileSync(join(podDir, "BOARD.json"), JSON.stringify(board, null, 2) + "\n", "utf-8");

  const gateStatus = args.gatesPass ? "pass" : "todo";
  const evidence = args.gateEvidence ? [{ ts: new Date().toISOString(), byRole: "qa", kind: "report", ref: "out/pw-report" }] : [];
  const ev = {
    version: 1,
    podId,
    gates: [
      {
        gateId: "tests_and_verification",
        title: "Tests + verification",
        ownerRole: "verifier",
        status: gateStatus,
        evidence,
      },
    ],
  };
  writeFileSync(join(podDir, "evidence", "EVIDENCE.json"), JSON.stringify(ev, null, 2) + "\n", "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-pod-verify-"));
  program = new Command();
  program.exitOverride();
  registerPod(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("pod verify", () => {
  it("prints SHIP: YES when board is done and gates are pass with evidence", async () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(repoRoot, { recursive: true });

    const podId = "pod-1";
    seedPodRepo(repoRoot, podId, { done: true, gatesPass: true, gateEvidence: true });

    await program.parseAsync(["node", "test", "pod", "verify", podId, "--repo", repoRoot]);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleSpy.mock.calls.some((c) => String(c[0]).includes("SHIP: YES"))).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("fails (process.exit(1)) when a gate is not pass/waived", async () => {
    const repoRoot = join(tmpDir, "repo");
    mkdirSync(repoRoot, { recursive: true });

    const podId = "pod-2";
    seedPodRepo(repoRoot, podId, { done: true, gatesPass: false, gateEvidence: false });

    await expect(
      program.parseAsync(["node", "test", "pod", "verify", podId, "--repo", repoRoot]),
    ).rejects.toThrow("process.exit(1)");

    expect(consoleSpy.mock.calls.some((c) => String(c[0]).includes("SHIP: NO"))).toBe(true);
  });
});

