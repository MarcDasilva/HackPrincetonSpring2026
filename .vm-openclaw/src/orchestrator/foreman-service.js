import { AGENT_IDS, JOB_STATUS, MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, WORKER_IDS } from "../shared/constants.js";
import { withRetry } from "../lib/logger.js";
import { jobIdForCommand, parseHumanCommand } from "./command-parser.js";
import { createJobFromIntent, generateProactiveJobs } from "./job-generator.js";
import { chooseBestWorker } from "./job-scoring.js";
import { buildForemanSnapshot, buildTaskBrief } from "./snapshot-builder.js";
import { buildForemanPlanningPrompt } from "./planner-prompts.js";
import { queueOutboundMessage } from "../lib/photon-bridge.js";

function isTransientStoreError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND"].includes(code)) return true;
  if (message.includes("bad gateway")) return true;
  if (message.includes("gateway timeout")) return true;
  if (message.includes("service unavailable")) return true;
  if (message.includes("timed out")) return true;
  if (message.includes("fetch failed")) return true;
  if (message.includes("network")) return true;
  return false;
}

export class ForemanService {
  constructor({ store, openclaw, logger }) {
    this.store = store;
    this.openclaw = openclaw;
    this.logger = logger;
    this.staleActiveJobMs = Number(process.env.STALE_ACTIVE_JOB_MS || 12 * 60 * 1000);
    this.tickInFlight = false;
  }

  async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
    const snapshot = await buildForemanSnapshot(this.store);
    await this.processInboundCommands(snapshot.inboundCommands);
    await this.recoverStaleActiveJobs(snapshot);
    const refreshed = await buildForemanSnapshot(this.store);
    await this.createProactiveJobs(refreshed);
    await this.assignPendingJobs(await buildForemanSnapshot(this.store));
    } finally {
      this.tickInFlight = false;
    }
  }

  async recoverStaleActiveJobs(snapshot) {
    const now = Date.now();
    for (const job of snapshot.activeJobs || []) {
      if (!job.assigned_agent || !job.started_at) continue;
      const startedAtMs = new Date(job.started_at).getTime();
      if (!Number.isFinite(startedAtMs)) continue;
      const ageMs = now - startedAtMs;
      if (ageMs < this.staleActiveJobMs) continue;
      try {
        const ageMinutes = Math.round(ageMs / 60000);
        this.logger.warn("Reclaiming stale active job", {
          job_id: job.job_id,
          assigned_agent: job.assigned_agent,
          age_minutes: ageMinutes,
        });
        await withRetry(() => this.store.updateJob(job.id, {
          status: JOB_STATUS.failed,
          completed_at: new Date().toISOString(),
          result: { error: `stale active job reclaimed after ${ageMinutes}m` },
        }), { retries: 2, baseDelayMs: 300 });
        await withRetry(() => this.store.heartbeat(job.assigned_agent, {
          status: "idle",
          current_job_id: null,
          current_task: null,
        }), { retries: 2, baseDelayMs: 300 });
        await withRetry(() => this.store.addJobEvent(job.id, AGENT_IDS.foreman, "failed", {
          reason: "stale_active_timeout",
          age_ms: ageMs,
        }), { retries: 2, baseDelayMs: 300 });
      } catch (error) {
        this.logger.error("Failed to reclaim stale active job", {
          job_id: job.job_id,
          error: error.message,
        });
      }
    }
  }

  async processInboundCommands(messages) {
    for (const message of messages) {
      try {
        this.logger.info("Processing inbound command", {
          message_id: message.id,
          source_chat: message.source_chat,
          sender: message.sender,
          raw_text: message.content || message.raw_text || "",
        });
        const intent = parseHumanCommand(message);
        intent.job_id = jobIdForCommand(intent);
        const createdJob = await withRetry(() => this.store.createJob(createJobFromIntent(intent)), {
          retries: 4,
          baseDelayMs: 400,
        });
        await withRetry(() => this.store.updateChatMessage(message.id, {
          processing_status: MESSAGE_PROCESSING_STATUS.processed,
          metadata: { ...message.metadata, parsed_intent: intent },
        }), {
          retries: 4,
          baseDelayMs: 400,
        });
        await withRetry(() => this.store.addJobEvent(createdJob.id, AGENT_IDS.foreman, "created", {
          source_message_id: message.id,
          intent,
        }), {
          retries: 4,
          baseDelayMs: 400,
        });
        this.logger.info("Inbound command processed", {
          message_id: message.id,
          job_id: intent.job_id,
          kind: intent.kind,
          target: intent.target,
          preferred_worker_role: intent.preferred_worker_role || null,
        });
      } catch (error) {
        const transient = isTransientStoreError(error);
        this.logger.warn("Failed to process inbound command", {
          id: message.id,
          error: error.message,
          transient,
        });
        if (transient) {
          this.logger.warn("Deferring inbound command for automatic retry", { id: message.id });
          continue;
        }
        try {
          await withRetry(() => this.store.updateChatMessage(message.id, { processing_status: MESSAGE_PROCESSING_STATUS.failed }), {
            retries: 2,
            baseDelayMs: 300,
          });
        } catch (statusError) {
          this.logger.error("Failed to mark inbound command as failed", {
            id: message.id,
            error: statusError.message,
          });
        }
      }
    }
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
    const busyAgents = new Set([
      ...workers
      .filter((worker) => worker.status === "busy" || worker.current_job_id)
      .map((worker) => worker.agent_id),
      ...(snapshot.activeJobs || []).map((job) => job.assigned_agent).filter(Boolean),
    ]);
    const assignments = [];
    for (const job of snapshot.pendingJobs) {
      if (job.assigned_agent) continue;
      const availableWorkers = workers.filter((worker) => !busyAgents.has(worker.agent_id));
      const choice = chooseBestWorker(job, availableWorkers, snapshot.worldObjects);
      if (!choice) continue;
      if (choice.score < 30) {
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

  async publishPlanSummary(text) {
    if (!text) return null;
    return queueOutboundMessage(this.store, { speakerAgentId: "foreman", body: text, metadata: { kind: "foreman_summary" } });
  }
}
