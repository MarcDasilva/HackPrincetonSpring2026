/**
 * Photon iMessage orchestrator.
 *
 * Flow:
 * 1. Photon receives a user request.
 * 2. OpenAI proposes an agent plan and Photon asks the user to reply yes.
 * 3. If the user revises the plan, Photon iterates until the plan is approved.
 * 4. Once approved, Photon launches the OpenClaw handoff in the background and
 *    persists progress so the run can be tracked outside the chat.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getPhotonCredentials() {
  const projectId = process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID;
  const projectSecret =
    process.env.PHOTON_PROJECT_SECRET ||
    process.env.PROJECT_SECRET ||
    process.env.SECRET_KEY;

  return {
    projectId,
    projectSecret,
    enabled: Boolean(projectId && projectSecret),
  };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENCLAW_COMMAND = process.env.OPENCLAW_COMMAND;
const PHOTON_TRACKING_DIR =
  process.env.PHOTON_TRACKING_DIR || path.join(__dirname, "photon-progress");
const PROPOSALS_DIR = path.join(PHOTON_TRACKING_DIR, "proposals");
const RUNS_DIR = path.join(PHOTON_TRACKING_DIR, "runs");
const TRACKER_INDEX_PATH = path.join(PHOTON_TRACKING_DIR, "index.json");

const pendingApprovals = new Map();
const activeRuns = new Map();
const allRuns = new Map();
const spaceRuns = new Map();
const CANONICAL_WORKER_ROLES = ["miner", "builder", "forager"];

const MINECRAFT_AGENT_BOILERPLATE = [
  "I can help orchestrate Minecraft agents.",
  "Try a request like:",
  "\"Start 2 Minecraft agents: one miner to gather iron and one builder to make a shelter.\"",
  "I'll propose the handoff first, then wait for you to reply YES before I launch it.",
].join("\n");

const HELP_TEXT = [
  "Photon orchestration commands:",
  "/status — show the pending draft and active runs for this chat",
  "/status RUN_ID — show details for one run",
  "/approve — launch the current draft plan",
  "/cancel — clear the current draft, or cancel an active run when given a run id",
  "/help — show this help",
  "",
  "Normal flow:",
  "1. Send a task.",
  "2. Photon proposes the agent handoff.",
  "3. Reply YES to launch, or reply with edits to revise the plan.",
].join("\n");

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of ensureArray(values)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }

  return result;
}

function explicitWorkerRole(text) {
  const lower = `${text || ""}`.toLowerCase();

  if (/\bminer\b/.test(lower)) return "miner";
  if (/\bbuilder\b/.test(lower)) return "builder";
  if (/\bforager\b/.test(lower)) return "forager";
  return null;
}

function inferWorkerRoleFromTask(taskHint = "", index = 0) {
  const lower = `${taskHint || ""}`.toLowerCase();

  if (/\b(storage|chest|build|shelter|hut|base|smelt|furnace)\b/.test(lower)) {
    return "builder";
  }

  if (/\b(mine|ore|iron|coal|torch|pickaxe|stone|cobblestone)\b/.test(lower)) {
    return "miner";
  }

  if (/\b(dirt|sand|gravel|clay|material)\b/.test(lower)) {
    return index % 2 === 0 ? "builder" : "miner";
  }

  if (/\b(food|farm|harvest|wheat|animal|wood|log|tree|scout|explore)\b/.test(lower)) {
    return "forager";
  }

  return null;
}

function canonicalizeWorkerRole(roleHint, taskHint = "", fallback = "builder", index = 0) {
  const explicit = explicitWorkerRole(roleHint);
  if (explicit) return explicit;

  const inferred = inferWorkerRoleFromTask(
    `${roleHint || ""} ${taskHint || ""}`.trim(),
    index
  );
  if (inferred) return inferred;

  return CANONICAL_WORKER_ROLES.includes(fallback) ? fallback : "builder";
}

function normalizePriority(value) {
  return ["low", "normal", "high"].includes(value) ? value : "normal";
}

function truncate(value, max = 140) {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function toRelativeTrackingPath(filePath) {
  return path.relative(process.cwd(), filePath) || filePath;
}

function ensureTrackingDirectories() {
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getSpaceRunIds(spaceId) {
  if (!spaceRuns.has(spaceId)) {
    spaceRuns.set(spaceId, new Set());
  }
  return spaceRuns.get(spaceId);
}

function registerRunForSpace(spaceId, runId) {
  getSpaceRunIds(spaceId).add(runId);
}

function unregisterRunForSpace(spaceId, runId) {
  const ids = getSpaceRunIds(spaceId);
  ids.delete(runId);
  if (ids.size === 0) {
    spaceRuns.delete(spaceId);
  }
}

function isAffirmative(text) {
  return /^(yes|y|yeah|yep|confirm|confirmed|approve|approved|launch|go|go ahead|do it|looks good|sounds good)[.! ]*$/i.test(
    text.trim()
  );
}

function isNegativeOnly(text) {
  return /^(no|n|nope|nah|not yet|wait|hold on)[.! ]*$/i.test(text.trim());
}

function serializeProposalSummary(state) {
  return {
    proposal_id: state.id,
    status: state.status,
    revision: state.revision,
    task: state.proposal.task,
    agent_count: state.proposal.agent_count,
    agent_roles: state.proposal.agent_roles,
    updated_at: state.updatedAt,
    tracking_path: toRelativeTrackingPath(state.filePath),
  };
}

function serializeRunSummary(run) {
  return {
    run_id: run.id,
    status: run.status,
    task: run.task,
    agent_count: run.agentCount,
    agent_roles: run.agentRoles,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    latest_message: run.latestMessage,
    tracking_path: toRelativeTrackingPath(run.filePath),
  };
}

function updateTrackerIndex() {
  const pending = [...pendingApprovals.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(serializeProposalSummary);

  const runs = [...allRuns.values()]
    .sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt;
      const bTime = b.updatedAt || b.createdAt;
      return bTime.localeCompare(aTime);
    })
    .slice(0, 50)
    .map(serializeRunSummary);

  writeJsonFile(TRACKER_INDEX_PATH, {
    updated_at: nowIso(),
    pending_proposals: pending,
    runs,
  });
}

function normalizeAssignment(assignment, index, defaults) {
  const fallbackRole =
    inferWorkerRoleFromTask(
      typeof assignment?.task === "string" && assignment.task.trim()
        ? assignment.task.trim()
        : defaults.task || "",
      index
    ) ||
    defaults.roles[index] ||
    defaults.roles[0] ||
    "builder";

  const role = canonicalizeWorkerRole(
    typeof assignment?.role === "string" ? assignment.role.trim() : "",
    typeof assignment?.task === "string" && assignment.task.trim()
      ? assignment.task.trim()
      : defaults.task || "",
    fallbackRole,
    index
  );

  const task =
    typeof assignment?.task === "string" && assignment.task.trim()
      ? assignment.task.trim()
      : defaults.task || `Handle ${role} work for the overall request.`;

  return {
    id:
      typeof assignment?.id === "string" && assignment.id.trim()
        ? assignment.id.trim()
        : `agent-${index + 1}`,
    role,
    task,
    depends_on: uniqueStrings(assignment?.depends_on),
    deliverable:
      typeof assignment?.deliverable === "string" && assignment.deliverable.trim()
        ? assignment.deliverable.trim()
        : `Update for ${role}`,
    success_signal:
      typeof assignment?.success_signal === "string" && assignment.success_signal.trim()
        ? assignment.success_signal.trim()
        : `Task completed by ${role}`,
    priority: normalizePriority(assignment?.priority || defaults.priority),
  };
}

function normalizeProposal(raw, context) {
  const rawAssignments = ensureArray(raw?.agent_assignments);
  const rawRoles = uniqueStrings(raw?.agent_roles);
  const rolesFromAssignments = rawAssignments
    .map((assignment) =>
      typeof assignment?.role === "string" ? assignment.role.trim() : ""
    )
    .filter(Boolean);

  const task =
    typeof raw?.task === "string" && raw.task.trim() ? raw.task.trim() : null;
  let roles = uniqueStrings(
    [...rawRoles, ...rolesFromAssignments].map((role, index) =>
      canonicalizeWorkerRole(
        role,
        rawAssignments[index]?.task || task || "",
        inferWorkerRoleFromTask(rawAssignments[index]?.task || task || "", index) ||
          "builder",
        index
      )
    )
  );

  if (roles.length === 0 && task) {
    roles = [canonicalizeWorkerRole("", task, inferWorkerRoleFromTask(task, 0) || "builder", 0)];
  }

  let assignments = rawAssignments.map((assignment, index) =>
    normalizeAssignment(assignment, index, {
      roles,
      task,
      priority: normalizePriority(raw?.priority),
    })
  );

  if (assignments.length === 0 && roles.length > 0) {
    assignments = roles.map((role, index) =>
      normalizeAssignment({ role }, index, {
        roles,
        task,
        priority: normalizePriority(raw?.priority),
      })
    );
  }

  const requestedAgentCount = Number(raw?.agent_count);
  let agentCount = Number.isFinite(requestedAgentCount)
    ? Math.max(0, Math.floor(requestedAgentCount))
    : 0;

  if (assignments.length > agentCount) {
    agentCount = assignments.length;
  }
  if (!agentCount && roles.length > 0) {
    agentCount = roles.length;
  }
  if (!agentCount && task) {
    agentCount = 1;
  }

  if (task && agentCount === 0) {
    agentCount = 1;
  }

  while (task && assignments.length < agentCount) {
    assignments.push(
      normalizeAssignment({}, assignments.length, {
        roles,
        task,
        priority: normalizePriority(raw?.priority),
      })
    );
  }

  if (roles.length === 0 && assignments.length > 0) {
    roles = uniqueStrings(assignments.map((assignment) => assignment.role));
  }

  const startAgentOrchestration =
    Boolean(raw?.start_agent_orchestration) && Boolean(task);

  const constraints = uniqueStrings([
    ...ensureArray(raw?.constraints),
    ...ensureArray(raw?.handoff?.constraints),
  ]);

  const priority = normalizePriority(raw?.priority);
  const handoffMode = startAgentOrchestration ? "orchestrate" : "ignore";

  return {
    start_agent_orchestration: startAgentOrchestration,
    intent:
      typeof raw?.intent === "string" && raw.intent.trim()
        ? raw.intent.trim()
        : "start_ai_agents",
    task,
    objective:
      typeof raw?.objective === "string" && raw.objective.trim()
        ? raw.objective.trim()
        : task,
    agent_count: agentCount,
    agent_roles: roles,
    agent_assignments: assignments,
    priority,
    constraints,
    requires_clarification: Boolean(raw?.requires_clarification),
    clarification_question:
      typeof raw?.clarification_question === "string" &&
      raw.clarification_question.trim()
        ? raw.clarification_question.trim()
        : null,
    reasoning_summary:
      typeof raw?.reasoning_summary === "string" && raw.reasoning_summary.trim()
        ? raw.reasoning_summary.trim()
        : "Photon prepared a delegation plan.",
    approval_prompt:
      typeof raw?.approval_prompt === "string" && raw.approval_prompt.trim()
        ? raw.approval_prompt.trim()
        : "Reply YES to launch this plan, or tell me what to change.",
    handoff: {
      target: "openclaw",
      mode: handoffMode,
      task,
      constraints,
      requested_agent_count: agentCount,
      agent_assignments: assignments,
      source: {
        platform: "iMessage",
        sender_id: context.senderId,
        space_id: context.spaceId,
      },
    },
  };
}

async function requestOrchestrationProposal({
  senderId,
  spaceId,
  conversation,
  currentDraft = null,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for LLM intent parsing.");
  }

  const systemPrompt = [
    "You are the planning layer for a Photon iMessage orchestrator that delegates work to OpenClaw agents.",
    "Analyze the current user request plus any revision feedback and produce a launch-ready proposal.",
    "Photon must ask for explicit user approval before launching. Do not assume approval has already happened.",
    "Return JSON only. Do not wrap in markdown. Do not add commentary.",
    "Use short, concrete agent assignments. Only recommend multiple agents when coordination is genuinely useful.",
    `Only use these worker roles in agent_roles and agent_assignments.role: ${CANONICAL_WORKER_ROLES.join(", ")}.`,
    "Do not invent custom roles like planner, dirt farmer, architect, or general contractor.",
    "The downstream OpenClaw bridge only understands tasks that can be translated into these worker families:",
    "- miner: mine ore or coal, gather stone or dirt, craft torches, craft pickaxe, return to base, status, inventory.",
    "- builder: expand storage, smelt ore, gather wood, gather dirt or other building materials, return to base, status, inventory.",
    "- forager: gather food, gather wood, scout, return to base, status, inventory.",
    "If the request cannot be translated into those roles and task families, ask a clarification question instead of inventing unsupported roles or tasks.",
    "If the user is revising a draft, preserve already-agreed details unless the new feedback changes them.",
    "If the user is not asking for agent work, set start_agent_orchestration to false and handoff.mode to ignore.",
    "The JSON schema is:",
    "{",
    '  "start_agent_orchestration": boolean,',
    '  "intent": string,',
    '  "task": string | null,',
    '  "objective": string | null,',
    '  "agent_count": number,',
    '  "agent_roles": string[],',
    '  "agent_assignments": [',
    "    {",
    '      "id": string,',
    '      "role": string,',
    '      "task": string,',
    '      "depends_on": string[],',
    '      "deliverable": string,',
    '      "success_signal": string,',
    '      "priority": "low" | "normal" | "high"',
    "    }",
    "  ],",
    '  "priority": "low" | "normal" | "high",',
    '  "constraints": string[],',
    '  "requires_clarification": boolean,',
    '  "clarification_question": string | null,',
    '  "reasoning_summary": string,',
    '  "approval_prompt": string,',
    '  "handoff": {',
    '    "target": "openclaw",',
    '    "mode": "orchestrate" | "ignore",',
    '    "task": string | null,',
    '    "constraints": string[],',
    '    "requested_agent_count": number,',
    '    "agent_assignments": [',
    "      {",
    '        "id": string,',
    '        "role": string,',
    '        "task": string,',
    '        "depends_on": string[]',
    "      }",
    "    ],",
    '    "source": {',
    '      "platform": "iMessage",',
    '      "sender_id": string,',
    '      "space_id": string',
    "    }",
    "  }",
    "}",
    "The approval prompt should clearly ask the user to reply YES to launch, otherwise continue iterating.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            platform: "iMessage",
            sender_id: senderId,
            space_id: spaceId,
            conversation,
            current_draft: currentDraft,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response did not include message content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`OpenAI returned invalid JSON: ${content}`);
  }

  return normalizeProposal(parsed, { senderId, spaceId });
}

function serializeProposalState(state) {
  return {
    proposal_id: state.id,
    status: state.status,
    revision: state.revision,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    sender_id: state.senderId,
    space_id: state.spaceId,
    user_messages: state.userMessages,
    proposal: state.proposal,
    tracking_path: toRelativeTrackingPath(state.filePath),
  };
}

function persistProposalState(state) {
  writeJsonFile(state.filePath, serializeProposalState(state));
  updateTrackerIndex();
}

function serializeRun(run) {
  return {
    run_id: run.id,
    proposal_id: run.proposalId,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    sender_id: run.senderId,
    space_id: run.spaceId,
    task: run.task,
    intent: run.intent,
    priority: run.priority,
    constraints: run.constraints,
    agent_count: run.agentCount,
    agent_roles: run.agentRoles,
    agent_assignments: run.agentAssignments,
    latest_message: run.latestMessage,
    pid: run.pid,
    exit_code: run.exitCode,
    cancel_requested: run.cancelRequested,
    finalized: run.finalized,
    tracking_path: toRelativeTrackingPath(run.filePath),
    handoff_payload: run.payload,
    events: run.events,
  };
}

function persistRun(run) {
  run.updatedAt = nowIso();
  writeJsonFile(run.filePath, serializeRun(run));
  updateTrackerIndex();
}

function createProposalState({ senderId, spaceId, text, proposal }) {
  const proposalId = createId("proposal");
  const state = {
    id: proposalId,
    status: "pending",
    revision: 1,
    senderId,
    spaceId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    userMessages: [{ at: nowIso(), text }],
    proposal,
    filePath: path.join(PROPOSALS_DIR, `${proposalId}.json`),
  };

  pendingApprovals.set(spaceId, state);
  persistProposalState(state);
  return state;
}

function appendProposalFeedback(state, text) {
  state.userMessages.push({ at: nowIso(), text });
  state.updatedAt = nowIso();
}

function recordRunEvent(run, event) {
  const normalized = {
    at: nowIso(),
    ...event,
  };
  run.events.push(normalized);
  if (run.events.length > 500) {
    run.events = run.events.slice(-500);
  }
  run.latestMessage = normalized.message;
  run.updatedAt = normalized.at;
}

function formatAssignments(assignments) {
  if (!assignments.length) {
    return ["1. generalist — Handle the full request."];
  }

  return assignments.map((assignment, index) => {
    const dependencyText =
      assignment.depends_on.length > 0
        ? ` (depends on: ${assignment.depends_on.join(", ")})`
        : "";
    return `${index + 1}. ${assignment.role} — ${truncate(assignment.task, 160)}${dependencyText}`;
  });
}

function formatProposalMessage(state) {
  const proposal = state.proposal;
  const roleText =
    proposal.agent_roles.length > 0
      ? proposal.agent_roles.join(", ")
      : "generalist";

  const lines = [
    state.revision > 1 ? `Updated plan (rev ${state.revision}).` : "Proposed plan.",
    `Task: ${proposal.task || "unspecified"}`,
    `Agents: ${proposal.agent_count || 1}`,
    `Roles: ${roleText}`,
    `Priority: ${proposal.priority}`,
    "Assignments:",
    ...formatAssignments(proposal.agent_assignments),
  ];

  if (proposal.constraints.length > 0) {
    lines.push(`Constraints: ${proposal.constraints.join("; ")}`);
  }

  lines.push(`Summary: ${proposal.reasoning_summary}`);

  if (proposal.requires_clarification && proposal.clarification_question) {
    lines.push(`Open question: ${proposal.clarification_question}`);
  }

  lines.push(`Tracking: ${toRelativeTrackingPath(state.filePath)}`);
  lines.push(proposal.approval_prompt);
  lines.push("Use /status any time to inspect the current draft or active runs.");

  return lines.join("\n");
}

function formatRunStatus(run, { detailed = false } = {}) {
  const lines = [
    `Run ${run.id}`,
    `Status: ${run.status}`,
    `Task: ${run.task || "unspecified"}`,
    `Agents: ${run.agentCount || 1}`,
    `Roles: ${run.agentRoles.length > 0 ? run.agentRoles.join(", ") : "generalist"}`,
    `Tracking: ${toRelativeTrackingPath(run.filePath)}`,
  ];

  if (run.latestMessage) {
    lines.push(`Latest: ${truncate(run.latestMessage, 220)}`);
  }

  if (detailed) {
    const recentEvents = run.events.slice(-5);
    if (recentEvents.length > 0) {
      lines.push("Recent events:");
      for (const event of recentEvents) {
        const prefix = event.stream ? `[${event.stream}] ` : "";
        lines.push(`- ${prefix}${truncate(event.message, 220)}`);
      }
    }
  }

  return lines.join("\n");
}

function formatSpaceStatus(spaceId, requestedRunId = null) {
  if (requestedRunId) {
    const run = allRuns.get(requestedRunId);
    if (!run || run.spaceId !== spaceId) {
      return `I couldn't find run ${requestedRunId} in this chat.`;
    }
    return formatRunStatus(run, { detailed: true });
  }

  const lines = [];
  const pending = pendingApprovals.get(spaceId);

  if (pending) {
    lines.push(
      `Pending draft: ${pending.proposal.task || "unspecified"} ` +
      `(rev ${pending.revision}, ${pending.proposal.agent_count || 1} agents)`
    );
    lines.push(`Draft tracking: ${toRelativeTrackingPath(pending.filePath)}`);
  } else {
    lines.push("Pending draft: none");
  }

  const runIds = [...getSpaceRunIds(spaceId)];
  const recentRuns = runIds
    .map((runId) => allRuns.get(runId))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .slice(0, 3);

  if (recentRuns.length === 0) {
    lines.push("Runs: none");
  } else {
    lines.push("Runs:");
    for (const run of recentRuns) {
      lines.push(
        `- ${run.id} — ${run.status} — ${truncate(run.task || "unspecified", 100)}`
      );
    }
  }

  lines.push(`Tracker index: ${toRelativeTrackingPath(TRACKER_INDEX_PATH)}`);
  return lines.join("\n");
}

function createRunFromProposal(state) {
  const runId = createId("run");
  const run = {
    id: runId,
    proposalId: state.id,
    status: OPENCLAW_COMMAND ? "starting" : "logged",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    senderId: state.senderId,
    spaceId: state.spaceId,
    task: state.proposal.task,
    intent: state.proposal.intent,
    priority: state.proposal.priority,
    constraints: state.proposal.constraints,
    agentCount: state.proposal.agent_count,
    agentRoles: state.proposal.agent_roles,
    agentAssignments: state.proposal.agent_assignments,
    latestMessage: null,
    pid: null,
    exitCode: null,
    cancelRequested: false,
    finalized: false,
    stdoutBuffer: "",
    stderrBuffer: "",
    events: [],
    payload: null,
    child: null,
    filePath: path.join(RUNS_DIR, `${runId}.json`),
  };

  allRuns.set(runId, run);
  registerRunForSpace(state.spaceId, runId);
  recordRunEvent(run, {
    type: "plan-approved",
    message: "User approved the Photon handoff plan.",
  });
  persistRun(run);
  return run;
}

function buildLaunchPayload(proposalState, run) {
  const approvedAt = nowIso();

  return {
    session_id: run.id,
    proposal_id: proposalState.id,
    approved_at: approvedAt,
    conversation: proposalState.userMessages,
    tracking: {
      index_path: TRACKER_INDEX_PATH,
      proposal_path: proposalState.filePath,
      run_path: run.filePath,
    },
    ...proposalState.proposal,
    handoff: {
      ...proposalState.proposal.handoff,
      session_id: run.id,
      proposal_id: proposalState.id,
      approved_at: approvedAt,
      tracking: {
        index_path: TRACKER_INDEX_PATH,
        proposal_path: proposalState.filePath,
        run_path: run.filePath,
      },
      conversation: proposalState.userMessages,
    },
  };
}

async function safeSend(space, text) {
  try {
    await space.send(text);
  } catch (error) {
    console.error("❌ Failed to send iMessage reply:", error.message);
  }
}

function parseProgressLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    // Non-JSON progress lines are still useful.
  }
  return null;
}

function ingestRunLine(run, stream, line) {
  if (!line.trim()) return;

  console.log(`[OpenClaw ${run.id} ${stream}] ${line}`);
  const parsed = parseProgressLine(line);

  if (parsed?.state && typeof parsed.state === "string") {
    run.status = parsed.state;
  }

  recordRunEvent(run, {
    type: parsed?.type || "log",
    stream,
    agent: parsed?.agent || parsed?.role || null,
    message:
      parsed?.message ||
      parsed?.summary ||
      parsed?.status ||
      parsed?.state ||
      line,
    raw: line,
    data: parsed,
  });

  persistRun(run);
}

function consumeBufferedLines(run, stream, chunk) {
  const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  run[bufferKey] += chunk.toString();
  const lines = run[bufferKey].split(/\r?\n/);
  run[bufferKey] = lines.pop() || "";

  for (const line of lines) {
    ingestRunLine(run, stream, line);
  }
}

function flushRemainingBuffer(run, stream) {
  const bufferKey = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
  const remaining = run[bufferKey].trim();
  if (remaining) {
    ingestRunLine(run, stream, remaining);
  }
  run[bufferKey] = "";
}

function finalizeRun(run, code, errorMessage = null) {
  if (run.finalized) {
    return false;
  }
  run.finalized = true;
  flushRemainingBuffer(run, "stdout");
  flushRemainingBuffer(run, "stderr");

  run.exitCode = typeof code === "number" ? code : run.exitCode;
  run.endedAt = nowIso();

  if (run.cancelRequested) {
    run.status = "cancelled";
    recordRunEvent(run, {
      type: "cancelled",
      message: "Run was cancelled from Photon.",
    });
  } else if (errorMessage) {
    run.status = "failed";
    recordRunEvent(run, {
      type: "error",
      message: errorMessage,
    });
  } else if (run.status === "completed") {
    run.status = "completed";
    recordRunEvent(run, {
      type: "completed",
      message: "OpenClaw run completed successfully.",
    });
  } else if (code === 0) {
    const queued = run.events.some(
      (event) =>
        event.type === "bridge.enqueued" ||
        event.data?.state === "queued" ||
        event.type === "queued"
    );

    if (queued) {
      run.status = "queued";
      recordRunEvent(run, {
        type: "queued",
        message: "OpenClaw accepted the handoff and queued downstream agent work.",
      });
    } else {
      run.status = "completed";
      recordRunEvent(run, {
        type: "completed",
        message: "OpenClaw run completed successfully.",
      });
    }
  } else {
    run.status = "failed";
    recordRunEvent(run, {
      type: "failed",
      message: `OpenClaw process exited with code ${code}.`,
    });
  }

  run.child = null;
  activeRuns.delete(run.id);
  persistRun(run);
  return true;
}

function launchOpenClawRun(run, proposalState, space) {
  run.payload = buildLaunchPayload(proposalState, run);
  run.startedAt = nowIso();
  recordRunEvent(run, {
    type: "launch",
    message: OPENCLAW_COMMAND
      ? "OpenClaw launch requested."
      : "OPENCLAW_COMMAND not configured. Payload logged only.",
  });
  persistRun(run);

  if (!OPENCLAW_COMMAND) {
    console.log("📝 OPENCLAW_COMMAND not set. Handoff payload:");
    console.log(JSON.stringify(run.payload, null, 2));
    run.status = "logged";
    recordRunEvent(run, {
      type: "logged",
      message: "Run was approved and written to the tracking files, but not executed.",
    });
    persistRun(run);
    return;
  }

  const serialized = JSON.stringify(run.payload, null, 2);

  try {
    const child = spawn(OPENCLAW_COMMAND, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    run.child = child;
    run.pid = child.pid ?? null;
    run.status = "running";
    activeRuns.set(run.id, run);
    recordRunEvent(run, {
      type: "process-started",
      message: run.pid
        ? `OpenClaw process started with pid ${run.pid}.`
        : "OpenClaw process started.",
    });
    persistRun(run);

    child.stdout.on("data", (chunk) => {
      consumeBufferedLines(run, "stdout", chunk);
    });

    child.stderr.on("data", (chunk) => {
      consumeBufferedLines(run, "stderr", chunk);
    });

    child.on("error", async (error) => {
      const didFinalize = finalizeRun(
        run,
        null,
        `OpenClaw failed to start: ${error.message}`
      );
      if (!didFinalize) return;
      await safeSend(
        space,
        `Run ${run.id} failed to start.\nTracking: ${toRelativeTrackingPath(run.filePath)}`
      );
    });

    child.on("close", async (code) => {
      const didFinalize = finalizeRun(run, code);
      if (!didFinalize) return;
      await safeSend(
        space,
        [
          `Run ${run.id} ${run.status}.`,
          `Tracking: ${toRelativeTrackingPath(run.filePath)}`,
          run.latestMessage ? `Latest: ${truncate(run.latestMessage, 220)}` : null,
        ]
          .filter(Boolean)
          .join("\n")
      );
    });

    child.stdin.write(serialized);
    child.stdin.end();
  } catch (error) {
    finalizeRun(run, null, `OpenClaw failed to start: ${error.message}`);
    throw error;
  }
}

async function proposeNewPlan({ text, senderId, spaceId, space }) {
  const proposal = await requestOrchestrationProposal({
    text,
    senderId,
    spaceId,
    conversation: [{ at: nowIso(), text }],
  });

  console.log("   Parsed orchestration:");
  console.log(JSON.stringify(proposal, null, 2));

  if (!proposal.start_agent_orchestration) {
    await safeSend(space, MINECRAFT_AGENT_BOILERPLATE);
    return;
  }

  const state = createProposalState({ senderId, spaceId, text, proposal });
  await safeSend(space, formatProposalMessage(state));
}

async function revisePendingPlan({ state, text, senderId, spaceId, space }) {
  appendProposalFeedback(state, text);

  const revisedProposal = await requestOrchestrationProposal({
    senderId,
    spaceId,
    conversation: state.userMessages,
    currentDraft: state.proposal,
  });

  console.log("   Revised orchestration:");
  console.log(JSON.stringify(revisedProposal, null, 2));

  if (!revisedProposal.start_agent_orchestration) {
    state.status = "cancelled";
    persistProposalState(state);
    pendingApprovals.delete(spaceId);
    await safeSend(space, "No launch queued. Send a new task whenever you're ready.");
    return;
  }

  state.revision += 1;
  state.updatedAt = nowIso();
  state.proposal = revisedProposal;
  persistProposalState(state);
  await safeSend(space, formatProposalMessage(state));
}

async function approvePendingPlan({ state, space, spaceId }) {
  state.status = "approved";
  state.updatedAt = nowIso();
  persistProposalState(state);
  pendingApprovals.delete(spaceId);

  const run = createRunFromProposal(state);
  launchOpenClawRun(run, state, space);

  const launchText = OPENCLAW_COMMAND
    ? "Launching approved plan now."
    : "OPENCLAW_COMMAND is not configured, so I logged the approved handoff without executing it.";

  await safeSend(
    space,
    [
      launchText,
      `Run: ${run.id}`,
      `Tracking: ${toRelativeTrackingPath(run.filePath)}`,
      `Tracker index: ${toRelativeTrackingPath(TRACKER_INDEX_PATH)}`,
      "Use /status to follow the run.",
    ].join("\n")
  );
}

async function cancelPendingPlan({ state, space, spaceId }) {
  state.status = "cancelled";
  state.updatedAt = nowIso();
  persistProposalState(state);
  pendingApprovals.delete(spaceId);
  await safeSend(
    space,
    `Cancelled the pending draft.\nTracking: ${toRelativeTrackingPath(state.filePath)}`
  );
}

async function cancelRun({ run, space }) {
  if (!run) {
    await safeSend(space, "I couldn't find that run.");
    return;
  }

  if (!run.child || !activeRuns.has(run.id)) {
    await safeSend(
      space,
      `Run ${run.id} is not active anymore.\nTracking: ${toRelativeTrackingPath(run.filePath)}`
    );
    return;
  }

  run.cancelRequested = true;
  recordRunEvent(run, {
    type: "cancel-requested",
    message: "Cancellation requested from Photon.",
  });
  persistRun(run);
  run.child.kill("SIGTERM");
  await safeSend(
    space,
    `Cancellation requested for run ${run.id}.\nTracking: ${toRelativeTrackingPath(run.filePath)}`
  );
}

async function handleCommand({ text, space, spaceId }) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const lower = command.toLowerCase();
  const targetId = rest[0];

  if (lower === "/help") {
    await safeSend(space, HELP_TEXT);
    return true;
  }

  if (lower === "/status") {
    await safeSend(space, formatSpaceStatus(spaceId, targetId || null));
    return true;
  }

  if (lower === "/approve") {
    const state = pendingApprovals.get(spaceId);
    if (!state) {
      await safeSend(space, "There isn't a pending draft to approve right now.");
      return true;
    }
    await approvePendingPlan({ state, space, spaceId });
    return true;
  }

  if (lower === "/cancel") {
    if (targetId) {
      const run = allRuns.get(targetId);
      if (run && run.spaceId !== spaceId) {
        await safeSend(space, "I couldn't find that run in this chat.");
        return true;
      }
      await cancelRun({ run, space });
      return true;
    }

    const state = pendingApprovals.get(spaceId);
    if (!state) {
      await safeSend(space, "There isn't a pending draft to cancel right now.");
      return true;
    }

    await cancelPendingPlan({ state, space, spaceId });
    return true;
  }

  return false;
}

async function main() {
  ensureTrackingDirectories();

  console.log("🚀 Starting Photon iMessage orchestrator...");

  const photon = getPhotonCredentials();
  const app = await Spectrum(
    photon.enabled
      ? {
          projectId: photon.projectId,
          projectSecret: photon.projectSecret,
          providers: [imessage.config()],
        }
      : {
          providers: [imessage.config({ local: true })],
        }
  );

  console.log(
    photon.enabled
      ? "✅ Connected with Photon cloud! Listening for messages...\n"
      : "✅ Connected in local iMessage mode! Listening for messages...\n"
  );
  console.log(`🤖 OpenAI planning model: ${OPENAI_MODEL}`);
  console.log(
    OPENCLAW_COMMAND
      ? `🔀 OpenClaw handoff command configured: ${OPENCLAW_COMMAND}`
      : "🔀 OpenClaw handoff command not configured. Approved runs will be logged only."
  );
  console.log(`🗂️  Photon tracking directory: ${PHOTON_TRACKING_DIR}\n`);

  const seenMessages = new Set();
  const myNumber = process.env.IMESSAGE_BOT_ID || "+16504459079";

  for await (const [space, message] of app.messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);

    if (message.platform === "iMessage" && imessage(space).type === "group") {
      continue;
    }

    if (message.sender.id === myNumber || message.sender.id === "") {
      continue;
    }

    console.log(`📨 [${message.platform}] From: ${message.sender.id}`);

    try {
      switch (message.content.type) {
        case "text": {
          const text = message.content.text.trim();
          if (!text) break;

          console.log(`   Text: "${text}"`);

          const spaceId = space.id;
          const senderId = message.sender.id;

          if (await handleCommand({ text, space, spaceId })) {
            break;
          }

          const pending = pendingApprovals.get(spaceId);
          if (pending) {
            if (isAffirmative(text)) {
              await approvePendingPlan({ state: pending, space, spaceId });
            } else if (isNegativeOnly(text)) {
              await safeSend(
                space,
                "No problem. Tell me what you want changed and I'll revise the plan."
              );
            } else {
              await revisePendingPlan({
                state: pending,
                text,
                senderId,
                spaceId,
                space,
              });
            }
            break;
          }

          await proposeNewPlan({ text, senderId, spaceId, space });
          break;
        }

        case "attachment": {
          const bytes = await message.content.read();
          console.log(`   Attachment: ${message.content.name} (${bytes.length} bytes)`);
          await safeSend(
            space,
            `Received your file: ${message.content.name}\nSend a task when you're ready and I'll propose the handoff.`
          );
          break;
        }

        case "custom": {
          console.log("   Custom:", message.content.raw);
          break;
        }

        default:
          console.log(`   Unknown content type: ${message.content.type}`);
      }
    } catch (error) {
      console.error("❌ Error:", error);
      await safeSend(
        space,
        `I hit an error while processing that message: ${error.message}`
      );
    }

    console.log("");
  }
}

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  for (const run of activeRuns.values()) {
    if (run.child) {
      run.cancelRequested = true;
      run.child.kill("SIGTERM");
    }
  }
  process.exit(0);
});

main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
