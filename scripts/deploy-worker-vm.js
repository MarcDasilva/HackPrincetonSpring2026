#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const worker = process.argv.find((arg) => arg.startsWith("--worker="))?.split("=")[1] || process.argv[2];
const envByWorker = {
  miner: "DEDALUS_WORKER_MINER_MACHINE_ID",
  builder: "DEDALUS_WORKER_BUILDER_MACHINE_ID",
  forager: "DEDALUS_WORKER_FORAGER_MACHINE_ID",
};
const roleByWorker = {
  miner: "worker-miner",
  builder: "worker-builder",
  forager: "worker-forager",
};
if (!envByWorker[worker]) throw new Error("Usage: node scripts/deploy-worker-vm.js --worker=miner|builder|forager");
const machineId = process.env[envByWorker[worker]];
if (!machineId) throw new Error(`${envByWorker[worker]} is required`);

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
exec(machineId, `bash -lc '/home/machine/start-gateway.sh ${roleByWorker[worker]}'`);
