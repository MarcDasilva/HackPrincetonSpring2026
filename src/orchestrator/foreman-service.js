import { MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, WORKER_IDS } from "../shared/constants.js";
import { jobIdForCommand, parseHumanCommand } from "./command-parser.js";
import { createJobFromIntent, generateProactiveJobs } from "./job-generator.js";
import { chooseBestWorker } from "./job-scoring.js";
import { buildForemanSnapshot, buildTaskBrief } from "./snapshot-builder.js";
import { buildForemanPlanningPrompt } from "./planner-prompts.js";
import { queueOutboundMessage } from "../lib/photon-bridge.js";

export class ForemanService {
  constructor({ store, openclaw, logger }) {
    this.store = store;
    this.openclaw = openclaw;
    this.logger = logger;
  }

  async tick() {
    const snapshot = await buildForemanSnapshot(this.store);
    await this.processInboundCommands(snapshot.inboundCommands);
    const refreshed = await buildForemanSnapshot(this.store);
    await this.createProactiveJobs(refreshed);
    await this.assignPendingJobs(await buildForemanSnapshot(this.store));
  }

  async processInboundCommands(messages) {
    for (const message of messages) {
      try {
        const intent = parseHumanCommand(message);
        intent.job_id = jobIdForCommand(intent);
        await this.store.createJob(createJobFromIntent(intent));
        await this.store.updateChatMessage(message.id, {
          processing_status: MESSAGE_PROCESSING_STATUS.processed,
          metadata: { ...message.metadata, parsed_intent: intent },
        });
        await this.store.addJobEvent(null, "foreman", "created", { source_message_id: message.id, intent });
      } catch (error) {
        this.logger.warn("Failed to process inbound command", { id: message.id, error: error.message });
        await this.store.updateChatMessage(message.id, { processing_status: MESSAGE_PROCESSING_STATUS.failed });
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
    const busyAgents = new Set(workers
      .filter((worker) => worker.status === "busy" || worker.current_job_id)
      .map((worker) => worker.agent_id));
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
