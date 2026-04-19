import { JOB_STATUS } from "../shared/constants.js";
import { markJobComplete } from "../lib/supabase.js";
import { buildWorkerBlockerPrompt, buildWorkerClaimPrompt, buildWorkerCompletionPrompt } from "./worker-prompts.js";
import { ensureWorkerRegistered, startHeartbeat } from "./heartbeat.js";
import { publishWorkerStatus } from "./status-publisher.js";

export class WorkerRuntime {
  constructor({ workerId, store, openclaw, voyager, heartbeatIntervalMs = 5000, logger }) {
    this.workerId = workerId;
    this.store = store;
    this.openclaw = openclaw;
    this.voyager = voyager;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.runningJobs = new Set();
  }

  async start() {
    await ensureWorkerRegistered(this.store, this.workerId);
    this.stopHeartbeat = startHeartbeat(this.store, this.workerId, this.heartbeatIntervalMs, this.logger);
    const run = () => this.tick().catch((error) => this.logger.error("Worker tick failed", { workerId: this.workerId, error: error.message }));
    this.store.subscribe("jobs_history", run);
    run();
    this.interval = setInterval(run, 3000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.stopHeartbeat) this.stopHeartbeat();
  }

  async tick() {
    const jobs = await this.store.listJobs({ status: JOB_STATUS.active, assigned_agent: this.workerId });
    // A worker bot identity can only hold one stable MC session at a time.
    // Running multiple Voyager tasks concurrently causes duplicate_login kicks.
    if (this.runningJobs.size > 0) return;

    const nextJob = jobs
      .filter((job) => !this.runningJobs.has(job.id))
      .sort((a, b) => new Date(a.started_at || 0) - new Date(b.started_at || 0))[0];
    if (!nextJob) return;

    this.runningJobs.add(nextJob.id);
    this.executeJob(nextJob)
      .catch((error) => this.logger.error("Job execution failed", { job_id: nextJob.job_id, error: error.message }))
      .finally(() => this.runningJobs.delete(nextJob.id));
  }

  async executeJob(job) {
    const taskBrief = job.task_brief;
    await this.store.addJobEvent(job.id, this.workerId, "claimed", { task_brief: taskBrief });
    const claim = await this.openclaw.getWorkerMessage(buildWorkerClaimPrompt(this.workerId, taskBrief), {
      agentId: this.workerId,
      taskBrief,
    });
    await publishWorkerStatus(this.store, this.workerId, claim.public_text, { job_id: job.job_id, status: "claimed", source_chat: taskBrief.source_chat });

    try {
      await this.store.addJobEvent(job.id, this.workerId, "started", {});
      const result = await this.voyager.executeTask(taskBrief);
      for (const observation of result.observations || []) {
        await this.store.addMemory(this.workerId, observation.memory_type || "observation", observation.content || observation);
      }
      const completion = await this.openclaw.getWorkerMessage(buildWorkerCompletionPrompt(this.workerId, taskBrief, result), {
        agentId: this.workerId,
        taskBrief,
      });
      await markJobComplete(this.store, job, this.workerId, result);
      await publishWorkerStatus(this.store, this.workerId, completion.public_text, { job_id: job.job_id, status: "completed", source_chat: taskBrief.source_chat });
    } catch (error) {
      await this.store.updateJob(job.id, {
        status: JOB_STATUS.failed,
        result: { error: error.message },
        completed_at: new Date().toISOString(),
      });
      await this.store.heartbeat(this.workerId, { status: "idle", current_job_id: null, current_task: null });
      await this.store.addJobEvent(job.id, this.workerId, "failed", { error: error.message });
      const blocker = await this.openclaw.getWorkerMessage(buildWorkerBlockerPrompt(this.workerId, taskBrief, error), {
        agentId: this.workerId,
        taskBrief,
      });
      await publishWorkerStatus(this.store, this.workerId, blocker.public_text, { job_id: job.job_id, status: "failed", source_chat: taskBrief.source_chat });
    }
  }
}
