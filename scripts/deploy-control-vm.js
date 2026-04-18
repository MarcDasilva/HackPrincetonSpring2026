#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const machineId = process.env.DEDALUS_CONTROL_MACHINE_ID;
if (!machineId) throw new Error("DEDALUS_CONTROL_MACHINE_ID is required");

function run(args) {
  const result = spawnSync("dedalus", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function exec(machineId, command, timeoutMs = 600000) {
  run([
    "machines:executions",
    "create",
    "--machine-id",
    machineId,
    "--command",
    command,
    "--timeout-ms",
    String(timeoutMs),
  ]);
}

exec(machineId, "bash -lc 'curl -fsSL https://raw.githubusercontent.com/MarcDasilva/HackPrincetonSpring2026/openclaw/scripts/bootstrap-openclaw-vm.sh | bash'");
exec(machineId, "bash -lc '/home/machine/start-gateway.sh foreman'");
