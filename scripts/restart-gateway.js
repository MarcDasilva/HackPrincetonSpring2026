#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const role = process.argv.find((arg) => arg.startsWith("--role="))?.split("=")[1] || "foreman";
const machineEnvByRole = {
  foreman: "DEDALUS_CONTROL_MACHINE_ID",
  photon: "DEDALUS_CONTROL_MACHINE_ID",
  voyager: "DEDALUS_CONTROL_MACHINE_ID",
  "multi-agent": "DEDALUS_CONTROL_MACHINE_ID",
  "openclaw-gateways": "DEDALUS_CONTROL_MACHINE_ID",
  "worker-miner": "DEDALUS_WORKER_MINER_MACHINE_ID",
  "worker-builder": "DEDALUS_WORKER_BUILDER_MACHINE_ID",
  "worker-forager": "DEDALUS_WORKER_FORAGER_MACHINE_ID",
};
const machineArg = process.argv.find((arg) => arg.startsWith("--machine="))?.split("=")[1];
const machineEnv = machineEnvByRole[role] || "DEDALUS_CONTROL_MACHINE_ID";
const machineId = machineArg || process.env[machineEnv] || process.env.DEDALUS_CONTROL_MACHINE_ID;
if (!machineId) throw new Error(`Pass --machine=<id> or set ${machineEnv}`);

const command = [
  `if [ -f /home/machine/${role}.pid ]; then kill $(cat /home/machine/${role}.pid) || true; fi`,
  `/home/machine/start-gateway.sh ${role}`,
].join(" && ");

const result = spawnSync("dedalus", [
  "machines:executions",
  "create",
  "--machine-id",
  machineId,
  "--command",
  JSON.stringify(["/bin/bash", "-c", command]),
  "--timeout-ms",
  "120000",
], { input: "{}", stdio: ["pipe", "inherit", "inherit"] });
process.exit(result.status || 0);
