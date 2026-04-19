import { AGENT_IDS, JOB_STATUS, MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, WORKER_IDS, WORKER_ROLES } from "../shared/constants.js";
import { JOB_KINDS } from "../shared/job-types.js";
import { jobIdForCommand, parseHumanCommand } from "./command-parser.js";
import { createJobsFromIntent, generateProactiveJobs } from "./job-generator.js";
import { chooseBestWorker } from "./job-scoring.js";
import { buildForemanSnapshot, buildTaskBrief } from "./snapshot-builder.js";
import { buildForemanPlanningPrompt } from "./planner-prompts.js";
import { isAllowedDirectSender, queueOutboundMessage } from "../lib/photon-bridge.js";

function workerDisplay(workerId) {
  return WORKER_ROLES[workerId]?.displayName || workerId;
}

function describeJob(job) {
  const preferred = job.payload?.preferred_worker_id;
  const target = job.target ? ` ${job.target}` : "";
  return `${preferred ? workerDisplay(preferred) : "best worker"}: ${job.kind}${target}`;
}

function formatDispatchSummary(intent, jobs) {
  const text = intent.request_text || intent.raw_text || "the request";
  if (jobs.length === 1) {
    return `Foreman: heard "${text}". Delegating ${describeJob(jobs[0])}.`;
  }
  return `Foreman: heard "${text}". Coordinating ${jobs.length} tasks: ${jobs.map(describeJob).join("; ")}.`;
}

function isDirectMessage(message) {
  const sourceChat = String(message?.source_chat || "");
  return message?.metadata?.channel === "dm" || sourceChat.startsWith("any;-;") || sourceChat.includes(";-;");
}

function shouldPublishPlanSummary(message, jobs) {
  if (isDirectMessage(message)) return false;
  return jobs.length > 1;
}

function isReadOnlyIntent(intent) {
  return [JOB_KINDS.reportStatus, JOB_KINDS.inventoryCheck].includes(intent.kind);
}

function isIgnorableInboundMessage(message) {
  const text = String(message?.content || message?.raw_text || "").trim();
  if (!text) return "empty_message";
  if (/^https?:\/\/\S+$/i.test(text)) return "link_without_instruction";
  return null;
}

function directMessageIgnoredReason(message, allowedDmSenders = []) {
  if (!isDirectMessage(message)) return null;
  if (message.metadata?.channel !== "dm") return "untrusted_dm_source";
  if (
    allowedDmSenders.length > 0 &&
    !isAllowedDirectSender(message.sender, allowedDmSenders) &&
    !isAllowedDirectSender(message.source_chat, allowedDmSenders)
  ) {
    return "dm_sender_not_allowlisted";
  }
  return null;
}

function itemDisplayName(itemName) {
  return String(itemName || "items").replaceAll("_", " ");
}

function countItemInInventory(inventory, itemName) {
  if (!Array.isArray(inventory) || !itemName) return 0;
  return inventory.reduce((total, item) => {
    if (typeof item === "string") return total + (item === itemName ? 1 : 0);
    const name = item?.item_name || item?.name || item?.type;
    return total + (name === itemName ? Number(item.count || item.quantity || 1) : 0);
  }, 0);
}

function countKnownItem(snapshot, itemName) {
  if (!itemName) return null;
  let total = 0;
  for (const object of snapshot.worldObjects || []) {
    total += countItemInInventory(object.metadata?.items, itemName);
    total += countItemInInventory(object.metadata?.inventory, itemName);
    total += Number(object.metadata?.stock?.[itemName] || 0);
  }
  for (const worker of snapshot.workers || []) {
    total += countItemInInventory(worker.metadata?.inventory, itemName);
    total += Number(worker.metadata?.stock?.[itemName] || 0);
  }
  return total;
}

function formatJobList(jobs) {
  if (!jobs.length) return "none";
  return jobs.slice(0, 4).map((job) => {
    const assignee = job.assigned_agent ? workerDisplay(job.assigned_agent) : "unassigned";
    return `${job.kind}${job.target ? ` ${itemDisplayName(job.target)}` : ""} (${assignee})`;
  }).join("; ");
}

function formatReadOnlyResponse(intent, snapshot) {
  if (intent.kind === JOB_KINDS.inventoryCheck) {
    const itemName = intent.target;
    if (itemName) {
      const count = countKnownItem(snapshot, itemName);
      return `Inventory check: I see ${count} ${itemDisplayName(itemName)} recorded.`;
    }
    return "Inventory check: ask for a specific item, like wood, stone, food, iron, or torches.";
  }

  const workers = (snapshot.workers || []).map((worker) => {
    const display = workerDisplay(worker.agent_id);
    return `${display} ${worker.status || "unknown"}${worker.current_task ? ` on ${worker.current_task}` : ""}`;
  }).join("; ") || "no workers registered";
  const active = formatJobList(snapshot.activeJobs || []);
  const pending = formatJobList((snapshot.pendingJobs || []).filter((job) => job.status !== JOB_STATUS.completed));
  return `Status: ${workers}. Active: ${active}. Pending: ${pending}.`;
}

export class ForemanService {
  constructor({ store, openclaw, logger, allowedDmSenders = [] }) {
    this.store = store;
    this.openclaw = openclaw;
    this.logger = logger;
    this.allowedDmSenders = allowedDmSenders;
    this.registered = false;
    this.ticking = false;
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.ensureRegistered();
      const snapshot = await buildForemanSnapshot(this.store);
      await this.processInboundCommands(snapshot.inboundCommands, snapshot);
      const refreshed = await buildForemanSnapshot(this.store);
      await this.createProactiveJobs(refreshed);
      await this.assignPendingJobs(await buildForemanSnapshot(this.store));
    } finally {
      this.ticking = false;
    }
  }

  async ensureRegistered() {
    if (this.registered) return;
    await this.store.upsertAgentStatus({
      agent_id: AGENT_IDS.foreman,
      display_name: "Foreman",
      role: "foreman",
      vm_name: null,
      status: "idle",
      current_task: null,
      metadata: { service: "orchestrator" },
    });
    this.registered = true;
  }

  async processInboundCommands(messages, snapshot = {}) {
    for (const message of messages) {
      try {
        const ignoredReason = directMessageIgnoredReason(message, this.allowedDmSenders) || isIgnorableInboundMessage(message);
        if (ignoredReason) {
          await this.store.updateChatMessage(message.id, {
            processing_status: MESSAGE_PROCESSING_STATUS.ignored,
            metadata: { ...message.metadata, ignored_reason: ignoredReason },
          });
          continue;
        }
        const intent = parseHumanCommand(message);
        intent.job_id = jobIdForCommand(intent);
        await this.store.updateChatMessage(message.id, {
          processing_status: MESSAGE_PROCESSING_STATUS.processed,
          metadata: { ...message.metadata, parsed_intent: intent, created_jobs: [] },
        });
        if (isReadOnlyIntent(intent)) {
          await this.rememberInboundCommand(message, intent, []);
          await this.publishPlanSummary(formatReadOnlyResponse(intent, snapshot), message.source_chat, { kind: "status_report", important: true });
          await this.store.updateChatMessage(message.id, {
            processing_status: MESSAGE_PROCESSING_STATUS.processed,
            metadata: { ...message.metadata, parsed_intent: intent, created_jobs: [], handled_as: "read_only" },
          });
          continue;
        }
        const jobs = [];
        for (const job of createJobsFromIntent(intent)) {
          jobs.push(await this.store.createJob(job));
        }
        await this.rememberInboundCommand(message, intent, jobs);
        if (shouldPublishPlanSummary(message, jobs)) {
          await this.publishPlanSummary(formatDispatchSummary(intent, jobs), message.source_chat);
        }
        await this.store.updateChatMessage(message.id, {
          processing_status: MESSAGE_PROCESSING_STATUS.processed,
          metadata: { ...message.metadata, parsed_intent: intent, created_jobs: jobs.map((job) => job.job_id) },
        });
        await this.store.addJobEvent(null, AGENT_IDS.foreman, "created", { source_message_id: message.id, intent, jobs: jobs.map((job) => job.job_id) });
      } catch (error) {
        this.logger.warn("Failed to process inbound command", { id: message.id, error: error.message });
        await this.store.updateChatMessage(message.id, { processing_status: MESSAGE_PROCESSING_STATUS.failed });
      }
    }
  }

  async rememberInboundCommand(message, intent, jobs) {
    const content = {
      source_message_id: message.id,
      source_chat: message.source_chat,
      sender: message.sender,
      text: message.content,
      parsed_intent: {
        kind: intent.kind,
        target: intent.target,
        quantity: intent.quantity,
        shortcut: intent.shortcut,
        plan_summary: intent.plan?.summary || null,
      },
      planned_jobs: jobs.map((job) => ({
        job_id: job.job_id,
        kind: job.kind,
        target: job.target,
        preferred_worker_id: job.payload?.preferred_worker_id || null,
      })),
    };

    await Promise.all(WORKER_IDS.map(async (workerId) => {
      try {
        const status = await this.store.getAgentStatus?.(workerId);
        if (!status) return;
        await this.store.addMemory(workerId, "observation", {
          ...content,
          channel: message.metadata?.channel === "dm" ? "dm" : "group",
        });
      } catch (error) {
        this.logger.debug("Skipped group-chat memory for worker", { workerId, error: error.message });
      }
    }));
  }

  async createProactiveJobs(snapshot) {
    for (const job of generateProactiveJobs({
      worldObjects: snapshot.worldObjects,
      stockTargets: snapshot.stockTargets,
      existingJobs: [...snapshot.pendingJobs, ...snapshot.activeJobs],
    })) {
      await this.store.createJob(job);
    }
  }

  async assignPendingJobs(snapshot) {
    if (snapshot.pendingJobs.length === 0) return [];
    await this.openclaw?.getForemanPlan?.(buildForemanPlanningPrompt(snapshot)).catch((error) => {
      this.logger.debug("Foreman OpenClaw plan skipped", { error: error.message });
    });

    const workers = snapshot.workers.filter((worker) => WORKER_IDS.includes(worker.agent_id));
    const busyAgents = new Set(workers
      .filter((worker) => worker.status === "busy" || worker.current_job_id)
      .map((worker) => worker.agent_id));
    const assignments = [];
    for (const job of snapshot.pendingJobs) {
      if (job.assigned_agent) continue;
      const availableWorkers = workers.filter((worker) => !busyAgents.has(worker.agent_id));
      const preferredWorkers = this.filterPreferredWorkers(job, availableWorkers);
      const choice = chooseBestWorker(job, preferredWorkers.length ? preferredWorkers : availableWorkers, snapshot.worldObjects);
      if (!choice) continue;
      const explicitlyTargeted = Boolean(job.payload?.preferred_worker_id || job.payload?.preferred_worker_role);
      if (choice.score < 30 && !explicitlyTargeted) {
        this.logger.debug("Leaving job pending because no worker fit is high enough", { job_id: job.job_id, score: choice.score });
        continue;
      }
      const worker = choice.worker;
      const triggerMessage = await this.findTriggerMessage(job);
      const taskBrief = await buildTaskBrief(this.store, job, worker, triggerMessage);
      const claimed = await this.store.claimJobHistory(job.id, worker.agent_id, taskBrief);
      if (claimed) {
        busyAgents.add(worker.agent_id);
        assignments.push({ job: claimed, worker, score: choice.score });
        this.logger.info("Assigned job", { job_id: claimed.job_id, worker: worker.agent_id, score: choice.score });
      }
    }
    return assignments;
  }

  filterPreferredWorkers(job, workers) {
    const preferredWorkerId = job.payload?.preferred_worker_id;
    if (preferredWorkerId) return workers.filter((worker) => worker.agent_id === preferredWorkerId);
    const preferredRole = job.payload?.preferred_worker_role;
    if (preferredRole) {
      return workers.filter((worker) => (worker.role || WORKER_ROLES[worker.agent_id]?.role) === preferredRole);
    }
    return [];
  }

  async findTriggerMessage(job) {
    const sourceId = job.payload?.source_message_id;
    if (!sourceId) return null;
    const messages = await this.store.listChatMessages({ direction: MESSAGE_DIRECTION.inbound });
    return messages.find((message) => message.id === sourceId) || null;
  }

  start() {
    const run = () => this.tick().catch((error) => this.logger.error("Foreman tick failed", { error: error.message }));
    for (const table of ["chat_messages", "jobs_history", "agent_status", "world_objects", "job_events"]) {
      this.store.subscribe(table, run);
    }
    run();
    this.interval = setInterval(run, 5000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  async publishPlanSummary(text, sourceChat = "group_chat", metadata = { kind: "foreman_summary" }) {
    if (!text) return null;
    return queueOutboundMessage(this.store, { speakerAgentId: "foreman", body: text, metadata, sourceChat });
  }
}
