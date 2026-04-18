#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const machineId = process.argv.find((arg) => arg.startsWith("--machine="))?.split("=")[1] || process.env.DEDALUS_CONTROL_MACHINE_ID;
const role = process.argv.find((arg) => arg.startsWith("--role="))?.split("=")[1] || "foreman";
if (!machineId) throw new Error("Pass --machine=<id> or set DEDALUS_CONTROL_MACHINE_ID");

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
  `bash -lc '${command}'`,
  "--timeout-ms",
  "120000",
], { stdio: "inherit" });
process.exit(result.status || 0);
