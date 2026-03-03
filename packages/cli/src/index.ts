#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerPod } from "./commands/pod.js";

const program = new Command();

function getCliVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

program
  .name("ao")
  .description("Agent Orchestrator — manage parallel AI coding agents")
  .version(getCliVersion());

registerInit(program);
registerStart(program);
registerStop(program);
registerStatus(program);
registerSpawn(program);
registerBatchSpawn(program);
registerSession(program);
registerSend(program);
registerReviewCheck(program);
registerDashboard(program);
registerOpen(program);
registerPod(program);

program.parse();
