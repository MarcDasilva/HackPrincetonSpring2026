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
const machineId = args.machine || process.env[envByWorker[worker]];
const repoUrl = args.repo || process.env.OPENCLAW_REPO_URL || "https://github.com/MarcDasilva/HackPrincetonSpring2026.git";
const appBranch = args.branch || process.env.OPENCLAW_BRANCH || "openclaw";
const bootstrapScript = args["bootstrap-script"] || process.env.OPENCLAW_BOOTSTRAP_SCRIPT || "scripts/bootstrap-openclaw-vm.sh";
const role = args.role || roleByWorker[worker];
const allowedRoles = new Set(["worker-miner", "worker-builder", "worker-forager", "voyager", "multi-agent", "openclaw-gateways"]);
const shouldStart = !process.argv.includes("--no-start");

if (!machineId) throw new Error(`Pass --machine=<id> or set ${envByWorker[worker]}`);
if (!allowedRoles.has(role)) throw new Error(`Unsupported worker VM role: ${role}`);

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
