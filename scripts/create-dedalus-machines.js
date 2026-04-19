#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--") && arg.includes("="))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key, value.join("=")];
    }),
);

const roles = [
  ["control", "DEDALUS_CONTROL_MACHINE_ID"],
  ["worker-miner", "DEDALUS_WORKER_MINER_MACHINE_ID"],
  ["worker-builder", "DEDALUS_WORKER_BUILDER_MACHINE_ID"],
  ["worker-forager", "DEDALUS_WORKER_FORAGER_MACHINE_ID"],
];

const machineArgs = [
  "--vcpu",
  args.vcpu || process.env.DEDALUS_MACHINE_VCPU || "2",
  "--memory-mib",
  args["memory-mib"] || process.env.DEDALUS_MACHINE_MEMORY_MIB || "4096",
  "--storage-gib",
  args["storage-gib"] || process.env.DEDALUS_MACHINE_STORAGE_GIB || "20",
  "--format",
  "json",
];

function createMachine(role) {
  const result = spawnSync("dedalus", ["machines", "create", ...machineArgs], {
    encoding: "utf8",
    input: "{}",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.status !== 0) process.exit(result.status || 1);
  const parsed = JSON.parse(result.stdout);
  const machineId = parsed.machine_id || parsed.id;
  if (!machineId) {
    console.error(`Could not find machine id in create response for ${role}:`);
    console.error(result.stdout);
    process.exit(1);
  }
  return machineId;
}

if (!process.env.DEDALUS_API_KEY && !process.env.DEDALUS_X_API_KEY) {
  throw new Error("Set DEDALUS_API_KEY in your shell before creating machines.");
}

console.log("# Add these machine ids to your local .env file:");
for (const [role, envName] of roles) {
  const machineId = createMachine(role);
  console.log(`${envName}=${machineId}`);
}
