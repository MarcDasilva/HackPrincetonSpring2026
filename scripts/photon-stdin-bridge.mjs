import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function resolveOrchestratorPath() {
  const candidates = [
    process.env.OPENCLAW_ORCHESTRATOR_PATH,
    "/opt/openclaw-orchestrator",
    "/home/machine/openclaw-orchestrator",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const requiredFiles = [
      "src/config/env.js",
      "src/lib/supabase.js",
      "src/lib/photon-bridge.js",
    ];

    if (requiredFiles.every((file) => fs.existsSync(path.join(candidate, file)))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not resolve OpenClaw orchestrator path. Checked: ${candidates.join(", ")}. Set OPENCLAW_ORCHESTRATOR_PATH to the orchestrator checkout.`
  );
}

async function importOrchestratorModule(orchestratorRoot, relativePath) {
  const moduleUrl = pathToFileURL(path.join(orchestratorRoot, relativePath)).href;
  return import(moduleUrl);
}

const orchestratorRoot = resolveOrchestratorPath();
const { loadEnv } = await importOrchestratorModule(orchestratorRoot, "src/config/env.js");
const { createStateStore } = await importOrchestratorModule(
  orchestratorRoot,
  "src/lib/supabase.js"
);
const { ingestInboundMessage } = await importOrchestratorModule(
  orchestratorRoot,
  "src/lib/photon-bridge.js"
);

function findForemanPid() {
  if (process.env.OPENCLAW_FOREMAN_PID) {
    return String(process.env.OPENCLAW_FOREMAN_PID);
  }

  const foremanMatch =
    process.env.OPENCLAW_FOREMAN_MATCH || "node src/services/run-foreman.js";
  const entries = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  for (const entry of entries) {
    try {
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmdline.includes(foremanMatch)) {
        return entry;
      }
    } catch {
      // Ignore transient /proc reads.
    }
  }
  return null;
}

function loadEnvFromProc(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
  const env = {};
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const index = entry.indexOf("=");
    if (index === -1) continue;
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function normalizeText(...parts) {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function explicitRole(text) {
  const lower = normalizeText(text);

  if (/\bminer\b/.test(lower)) return "miner";
  if (/\bbuilder\b/.test(lower)) return "builder";
  if (/\bforager\b/.test(lower)) return "forager";
  return null;
}

function inferRole({ role, task, overallTask, index }) {
  const direct = explicitRole(role);
  if (direct) return direct;

  const text = normalizeText(role, task, overallTask);

  if (/\b(storage|chest|build|shelter|hut|smelt|furnace)\b/.test(text)) {
    return "builder";
  }

  if (/\b(mine|ore|iron|coal|torch|pickaxe|stone|cobblestone)\b/.test(text)) {
    return "miner";
  }

  if (/\b(dirt|sand|gravel|clay|material)\b/.test(text)) {
    return index % 2 === 0 ? "builder" : "miner";
  }

  if (/\b(food|farm|harvest|wheat|animal|wood|log|tree|scout|explore)\b/.test(text)) {
    return "forager";
  }

  return ["builder", "miner", "forager"][index % 3];
}

function inferMaterialTarget(text) {
  if (/\bdirt\b/.test(text)) return "dirt";
  if (/\bsand\b/.test(text)) return "sand";
  if (/\bgravel\b/.test(text)) return "gravel";
  if (/\bclay\b/.test(text)) return "clay";
  if (/\bcobblestone\b|\bcobble\b/.test(text)) return "cobblestone";
  if (/\bstone\b/.test(text)) return "stone";
  return "dirt";
}

function inferOreTarget(text) {
  if (/\biron\b/.test(text)) return "iron ore";
  if (/\bcoal\b/.test(text)) return "coal";
  return "ore";
}

function buildFallbackCommand(role) {
  if (role === "builder") return "@builder expand storage";
  if (role === "miner") return "@miner mine iron ore";
  return "@forager scout";
}

function buildCommand({ assignment, overallTask, index }) {
  const task = normalizeText(assignment?.task, overallTask);
  const directRole = explicitRole(assignment?.role || "");
  const role = inferRole({
    role: assignment?.role || "",
    task: assignment?.task || "",
    overallTask,
    index,
  });

  if (!task) return buildFallbackCommand(role);
  if (/\binventory\b/.test(task)) return "inventory";
  if (/\bstatus\b/.test(task)) return "status";
  if (/\breturn\b/.test(task) && /\bbase\b/.test(task)) return `@${role} return to base`;
  if (/\b(smelt|furnace)\b/.test(task)) return "@builder smelt raw iron";
  if (/\b(storage|chest|build|shelter|hut|base)\b/.test(task)) return "@builder expand storage";
  if (/\b(torch|torches)\b/.test(task)) return "@miner craft torches";
  if (/\b(pickaxe|tool|tools)\b/.test(task)) return "@builder craft pickaxe";
  if (/\b(dirt|sand|gravel|clay|stone|cobblestone|material)\b/.test(task)) {
    const worker =
      directRole === "builder" || directRole === "miner"
        ? directRole
        : index % 2 === 0
          ? "builder"
          : "miner";
    return `@${worker} gather ${inferMaterialTarget(task)}`;
  }
  if (/\b(ore|iron|coal|mine)\b/.test(task)) return `@miner mine ${inferOreTarget(task)}`;
  if (/\b(food|farm|harvest|wheat|animal|hungry)\b/.test(task)) return "@forager gather food";
  if (/\b(wood|log|tree|lumber)\b/.test(task)) {
    const worker = role === "miner" ? "builder" : role;
    return `@${worker} gather wood`;
  }
  if (/\b(scout|explore|survey|look around|map)\b/.test(task)) return "@forager scout";

  return buildFallbackCommand(role);
}

function buildCommands(payload) {
  const handoffAssignments = Array.isArray(payload.handoff?.agent_assignments)
    ? payload.handoff.agent_assignments
    : [];
  const rootAssignments = Array.isArray(payload.agent_assignments)
    ? payload.agent_assignments
    : [];
  const assignments = handoffAssignments.length > 0 ? handoffAssignments : rootAssignments;
  const overallTask = payload.task || payload.objective || payload.handoff?.task || "";

  if (assignments.length === 0) {
    return [buildCommand({ assignment: null, overallTask, index: 0 })];
  }

  return assignments.map((assignment, index) =>
    buildCommand({ assignment, overallTask, index })
  );
}

const stdinText = await readStdin();
if (!stdinText) {
  throw new Error("Expected JSON payload on stdin.");
}

const payload = JSON.parse(stdinText);
const foremanPid = findForemanPid();
const procEnv = foremanPid ? loadEnvFromProc(foremanPid) : {};
const config = loadEnv({ ...process.env, ...procEnv, PHOTON_MODE: "simulation" });
const store = await createStateStore(config);

const sourceChat = payload.handoff?.source?.space_id || payload.session_id || "photon-bridge";
const sender = payload.handoff?.source?.sender_id || "photon";
const commands = buildCommands(payload);

console.log(JSON.stringify({
  type: "bridge.accepted",
  state: "accepted",
  message: `Accepted Photon handoff for: ${payload.task || payload.objective || payload.handoff?.task || "unspecified task"}`,
  foreman_pid: foremanPid || null,
  orchestrator_root: orchestratorRoot,
  commands,
}));

const insertedIds = [];
for (const command of commands) {
  const inserted = await ingestInboundMessage(store, {
    sourceChat,
    sender,
    text: command,
  });

  insertedIds.push(inserted.id);

  console.log(JSON.stringify({
    type: "bridge.command",
    state: "queued",
    message: `Queued command: ${command}`,
    command_id: inserted.id,
    command,
    source_chat: sourceChat,
    sender,
  }));
}

console.log(JSON.stringify({
  type: "bridge.enqueued",
  state: "queued",
  message: `Enqueued ${insertedIds.length} inbound command(s).`,
  command_ids: insertedIds,
  source_chat: sourceChat,
  sender,
}));
