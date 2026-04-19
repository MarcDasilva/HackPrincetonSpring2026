import { JOB_STATUS, WORKER_ROLES } from "../shared/constants.js";
import { JOB_KINDS } from "../shared/job-types.js";
import { markJobComplete } from "../lib/supabase.js";
import { buildWorkerBlockerPrompt } from "./worker-prompts.js";
import { ensureWorkerRegistered, startHeartbeat } from "./heartbeat.js";
import { publishWorkerStatus } from "./status-publisher.js";

function isDeathSignal(value) {
  return /\b(died|death|dead|killed|slain)\b/i.test(String(value || ""));
}

function taskLabel(taskBrief) {
  return taskBrief?.target ? `${taskBrief.kind} ${taskBrief.target}` : taskBrief?.kind || "the task";
}

function dependencyLabel(dependency) {
  return String(dependency || "").replaceAll("_", " ");
}

function isDirectSourceChat(sourceChat) {
  const value = String(sourceChat || "");
  return value.startsWith("any;-;") || value.includes(";-;");
}

function workerDisplay(workerId) {
  return WORKER_ROLES[workerId]?.displayName || workerId;
}

function formatInventoryDelta(delta = {}) {
  const entries = Object.entries(delta)
    .filter(([, count]) => Number(count) !== 0)
    .map(([item, count]) => `${count} ${String(item).replaceAll("_", " ")}`);
  return entries.length ? ` Recorded: ${entries.join(", ")}.` : "";
}

function shouldPublishCompletion(job, result) {
  if (job.source !== "human") return false;
  if (result?.mode === "simulation") return false;
  if ([JOB_KINDS.reportStatus, JOB_KINDS.inventoryCheck].includes(job.kind)) return true;
  return job.payload?.notify_on_completion !== false;
}

function formatCompletionNotice(workerId, taskBrief, result) {
  const objective = taskBrief.objective || taskLabel(taskBrief);
  return `${workerDisplay(workerId)} finished: ${objective}.${formatInventoryDelta(result?.inventory_delta)}`;
}

function readinessError(readiness) {
  return `Minecraft runtime is not connected: ${readiness.reasons.join("; ")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WorkerRuntime {
  constructor({ workerId, store, openclaw, voyager, heartbeatIntervalMs = 5000, logger }) {
    this.workerId = workerId;
    this.store = store;
    this.openclaw = openclaw;
    this.voyager = voyager;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.logger = logger;
    this.runningJobs = new Set();
    this.ticking = false;
  }

  async start() {
    await ensureWorkerRegistered(this.store, this.workerId);
    const startupJoinDelayMs = this.voyager?.getStartupJoinDelayMs?.() || 0;
    if (startupJoinDelayMs > 0) {
      this.logger?.info("Delaying Minecraft join to avoid server reconnect throttling", {
        workerId: this.workerId,
        startupJoinDelayMs,
      });
      await sleep(startupJoinDelayMs);
    }
    await this.voyager?.ensureConnected?.();
    await this.refreshRuntimeReadiness();
    this.stopHeartbeat = startHeartbeat(this.store, this.workerId, this.heartbeatIntervalMs, this.logger);
    const run = () => this.tick().catch((error) => this.logger.error("Worker tick failed", { workerId: this.workerId, error: error.message }));
    this.store.subscribe("jobs_history", run);
    run();
    this.interval = setInterval(run, 3000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.stopHeartbeat) this.stopHeartbeat();
    this.voyager?.stopIdleConnection?.();
  }

  async tick() {
    if (this.ticking || this.runningJobs.size > 0) return;
    this.ticking = true;
    try {
      const runtimeReadiness = await this.refreshRuntimeReadiness();
      if (!runtimeReadiness.ready) {
        await this.blockActiveJobsForRuntime(runtimeReadiness);
        return;
      }
      const jobs = await this.store.listJobs({ status: JOB_STATUS.active, assigned_agent: this.workerId });
      const job = jobs.find((candidate) => !this.runningJobs.has(candidate.id));
      if (!job) return;
      this.runningJobs.add(job.id);
      this.executeJob(job)
        .catch((error) => this.logger.error("Job execution failed", { job_id: job.job_id, error: error.message }))
        .finally(() => this.runningJobs.delete(job.id));
    } finally {
      this.ticking = false;
    }
  }

  async executeJob(job) {
    const taskBrief = job.task_brief;
    const runtimeReadiness = await this.refreshRuntimeReadiness();
    if (!runtimeReadiness.ready) {
      await this.blockJobForRuntime(job, runtimeReadiness);
      return;
    }
    const readiness = await this.checkDependencies(job);
    if (!readiness.ready) {
      await this.publishWaitingForDependencies(job, readiness.pending);
      return;
    }
    if (readiness.dependencies.length) {
      taskBrief.coordination = {
        ...(taskBrief.coordination || {}),
        dependency_status: readiness.dependencies,
      };
    }

    await this.store.heartbeat(this.workerId, {
      status: "busy",
      current_job_id: job.id,
      current_task: taskLabel(taskBrief),
    });
    await this.store.addJobEvent(job.id, this.workerId, "claimed", { task_brief: taskBrief });

    try {
      await this.store.addJobEvent(job.id, this.workerId, "started", {});
      const result = await this.voyager.executeTask(taskBrief);
      if (result?.success === false) {
        const error = new Error(result.summary || result.error || "Voyager reported task failure");
        error.result = result;
        throw error;
      }
      for (const observation of result.observations || []) {
        await this.store.addMemory(this.workerId, observation.memory_type || "observation", observation.content || observation);
      }
      await markJobComplete(this.store, job, this.workerId, result);
      if (shouldPublishCompletion(job, result)) {
        await publishWorkerStatus(this.store, this.workerId, formatCompletionNotice(this.workerId, taskBrief, result), {
          job_id: job.job_id,
          status: "completed",
          source_chat: taskBrief.source_chat,
          important: true,
        });
      }
    } catch (error) {
      const death = isDeathSignal(error.message) || isDeathSignal(error.result?.summary) || isDeathSignal(error.result?.error);
      this.logger?.warn("Worker task did not complete", { workerId: this.workerId, job_id: job.job_id, error: error.message, death });
      await this.store.updateJob(job.id, {
        status: JOB_STATUS.failed,
        result: {
          error: error.message,
          intended_status: death ? "dead" : "blocked",
        },
      });
      await this.store.heartbeat(this.workerId, {
        status: death ? "dead" : "idle",
        current_job_id: null,
        current_task: null,
      });
      await this.store.addJobEvent(job.id, this.workerId, death ? "failed" : "blocked", { error: error.message, death });
      const blocker = await this.openclaw.getWorkerMessage(buildWorkerBlockerPrompt(this.workerId, taskBrief, error), {
        agentId: this.workerId,
        taskBrief,
      });
      const publicText = death ? `${this.workerId}: I died while working on ${taskLabel(taskBrief)}.` : blocker.public_text;
      await publishWorkerStatus(this.store, this.workerId, publicText, { job_id: job.job_id, status: death ? "dead" : "blocked", source_chat: taskBrief.source_chat });
    }
  }

  async checkDependencies(job) {
    const dependencies = job.payload?.depends_on || job.task_brief?.coordination?.depends_on || [];
    if (!dependencies.length) return { ready: true, pending: [], dependencies: [] };

    const planId = job.payload?.plan_id || job.task_brief?.coordination?.plan_id;
    if (!planId) return { ready: true, pending: [], dependencies: [] };

    const jobs = await this.store.listJobs();
    const planJobs = jobs.filter((candidate) => candidate.payload?.plan_id === planId);
    const dependencyStatus = dependencies.map((dependency) => {
      const match = planJobs.find((candidate) => (
        candidate.payload?.plan_step === dependency ||
        candidate.kind === dependency ||
        candidate.job_id === dependency
      ));
      return {
        dependency,
        job_id: match?.job_id || null,
        status: match?.status || "missing",
        assigned_agent: match?.assigned_agent || null,
        result: match?.result || null,
      };
    });
    const pending = dependencyStatus
      .filter((dependency) => dependency.status !== JOB_STATUS.completed)
      .map((dependency) => dependency.dependency);

    return { ready: pending.length === 0, pending, dependencies: dependencyStatus };
  }

  async refreshRuntimeReadiness() {
    const readiness = this.voyager?.getMinecraftReadiness
      ? await this.voyager.getMinecraftReadiness()
      : { ready: true, reasons: [], mode: "unknown" };
    const existing = await this.store.getAgentStatus?.(this.workerId);
    const metadata = {
      ...(existing?.metadata || {}),
      minecraft_runtime: {
        ready: readiness.ready,
        mode: readiness.mode || "unknown",
        reasons: readiness.reasons || [],
        minecraft: readiness.minecraft || {},
        checked_at: new Date().toISOString(),
      },
    };

    if (!readiness.ready) {
      await this.store.heartbeat(this.workerId, {
        status: "offline",
        current_job_id: null,
        current_task: "not connected to Minecraft",
        metadata,
      });
      return readiness;
    }

    if (existing?.status === "offline") {
      await this.store.heartbeat(this.workerId, {
        status: "idle",
        current_job_id: null,
        current_task: null,
        metadata,
      });
    } else if (existing) {
      await this.store.heartbeat(this.workerId, { metadata });
    }
    return readiness;
  }

  async blockActiveJobsForRuntime(readiness) {
    const jobs = await this.store.listJobs({ status: JOB_STATUS.active, assigned_agent: this.workerId });
    for (const job of jobs) {
      await this.blockJobForRuntime(job, readiness);
    }
  }

  async blockJobForRuntime(job, readiness) {
    const error = readinessError(readiness);
    this.logger?.warn("Worker cannot execute Minecraft job because runtime is not connected", {
      workerId: this.workerId,
      job_id: job.job_id,
      reasons: readiness.reasons,
    });
    await this.store.updateJob(job.id, {
      status: JOB_STATUS.blocked,
      result: {
        error,
        intended_status: "not_connected",
        readiness,
      },
    });
    await this.store.addJobEvent(job.id, this.workerId, "blocked", {
      reason: "minecraft_not_connected",
      readiness,
    });
  }

  async publishWaitingForDependencies(job, pending) {
    const now = Date.now();
    const lastNotice = Date.parse(job.payload?.last_wait_notice_at || 0);
    await this.store.heartbeat(this.workerId, {
      status: "busy",
      current_job_id: job.id,
      current_task: `waiting for ${pending.map(dependencyLabel).join(", ")}`,
    });
    await this.store.addJobEvent(job.id, this.workerId, "progress", {
      status: "waiting",
      waiting_for: pending,
    });
    if (Number.isFinite(lastNotice) && now - lastNotice < 30000) return;

    await this.store.updateJob(job.id, {
      payload: {
        ...job.payload,
        last_wait_notice_at: new Date(now).toISOString(),
      },
    });
    if (isDirectSourceChat(job.task_brief?.source_chat)) return;
    await publishWorkerStatus(this.store, this.workerId, `${this.workerId}: waiting on ${pending.map(dependencyLabel).join(" and ")} before ${taskLabel(job.task_brief)}.`, {
      job_id: job.job_id,
      status: "waiting",
      source_chat: job.task_brief?.source_chat,
    });
  }
}
