#!/usr/bin/env node
import { readFileSync } from "node:fs";
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

const machineId = args.machine || process.env.DEDALUS_CONTROL_MACHINE_ID;
const role = args.role || "foreman";
const allowedRoles = new Set(["foreman", "photon", "voyager", "multi-agent", "openclaw-gateways"]);
const repoUrl = args.repo || process.env.OPENCLAW_REPO_URL || "https://github.com/MarcDasilva/HackPrincetonSpring2026.git";
const appBranch = args.branch || process.env.OPENCLAW_BRANCH || "openclaw";
const bootstrapScript = args["bootstrap-script"] || process.env.OPENCLAW_BOOTSTRAP_SCRIPT || "scripts/bootstrap-openclaw-vm.sh";
const shouldStart = !process.argv.includes("--no-start");

if (!machineId) throw new Error("Pass --machine=<id> or set DEDALUS_CONTROL_MACHINE_ID");
if (!allowedRoles.has(role)) throw new Error(`Unsupported control VM role: ${role}`);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function run(args) {
  const result = spawnSync("dedalus", args, { input: "{}", stdio: ["pipe", "inherit", "inherit"] });
  if (result.status !== 0) process.exit(result.status || 1);
}

function exec(machineId, commandArray, { stdin = null, timeoutMs = 600000 } = {}) {
  const args = [
    "machines:executions",
    "create",
    "--machine-id",
    machineId,
    "--command",
    JSON.stringify(commandArray),
    "--timeout-ms",
    String(timeoutMs),
  ];
  if (stdin !== null) args.push("--stdin", stdin);
  run(args);
}

function execShell(machineId, command, options = {}) {
  return exec(machineId, ["/bin/bash", "-c", command], options);
}

function bootstrapVm() {
  const script = readFileSync(bootstrapScript, "utf8");
  const command = [
    `export OPENCLAW_REPO_URL=${shellQuote(repoUrl)}`,
    `export OPENCLAW_BRANCH=${shellQuote(appBranch)}`,
    "/bin/bash -s",
  ].join(" && ");
  run([
    "machines:executions",
    "create",
    "--machine-id",
    machineId,
    "--command",
    JSON.stringify(["/bin/bash", "-c", command]),
    "--stdin",
    script,
    "--timeout-ms",
    "600000",
  ]);
}

bootstrapVm();
if (shouldStart) execShell(machineId, `/home/machine/start-gateway.sh ${shellQuote(role)}`, { timeoutMs: 120000 });
