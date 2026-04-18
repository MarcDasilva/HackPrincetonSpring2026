/**
 * OpenClawExecutor — Connection layer between iMessage agents and an OpenClaw VM.
 *
 * API contract the VM must implement:
 *   POST /api/task          { agent: string, command: string } → { taskId: string, status: "queued" }
 *   GET  /api/task/:taskId  → { taskId, status, progress?, result?, error? }
 *   GET  /api/health        → { status: "ok", agents: string[], uptime: number }
 *
 * status values: "queued" | "running" | "completed" | "failed"
 */

const DEFAULT_REQUEST_TIMEOUT = 10_000; // 10 s per HTTP request
const DEFAULT_TASK_TIMEOUT = 300_000;   // 5 min max for a full task lifecycle
const POLL_INTERVAL = 2_000;            // 2 s between status polls

export class OpenClawExecutor {
  constructor({
    vmUrl,
    apiKey = null,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT,
    taskTimeout = DEFAULT_TASK_TIMEOUT,
    mockMode = false,
    agentDefinitions = null,
  }) {
    this.vmUrl = vmUrl?.replace(/\/$/, "") || "";
    this.apiKey = apiKey;
    this.requestTimeout = requestTimeout;
    this.taskTimeout = taskTimeout;
    this.mockMode = mockMode;
    this.agentDefinitions = agentDefinitions;
    this.isBusy = false;
    this.taskQueue = [];
    this._taskAbort = null;
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async _fetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeout);

    const onTaskAbort = () => controller.abort();
    const taskSignal = this._taskAbort?.signal;
    if (taskSignal) {
      if (taskSignal.aborted) {
        controller.abort();
      } else {
        taskSignal.addEventListener("abort", onTaskAbort, { once: true });
      }
    }

    try {
      const res = await fetch(`${this.vmUrl}${path}`, {
        ...options,
        headers: { ...this._headers(), ...options.headers },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
      }

      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON from VM: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
      taskSignal?.removeEventListener("abort", onTaskAbort);
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async _pollUntilDone(taskId, statusCallback) {
    const deadline = Date.now() + this.taskTimeout;

    while (Date.now() < deadline) {
      const data = await this._fetch(`/api/task/${taskId}`);

      if (statusCallback && data.progress) {
        try { await statusCallback(data.progress); } catch { /* non-fatal */ }
      }

      if (data.status === "completed") {
        return { success: true, result: data.result || "Task completed" };
      }
      if (data.status === "failed") {
        return { success: false, error: data.error || "Task failed on VM" };
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    return { success: false, error: `Task timed out after ${this.taskTimeout / 1000}s` };
  }

  // ---------------------------------------------------------------------------
  // Public interface (matches VoyagerExecutor / VoyagerSimulator)
  // ---------------------------------------------------------------------------

  async executeTask(agentType, command, statusCallback) {
    if (this.mockMode) {
      return this._executeMock(agentType, command, statusCallback);
    }

    this.isBusy = true;
    this._taskAbort = new AbortController();

    console.log(`\n🌐 [OpenClaw VM] Sending task...`);
    console.log(`   Agent: ${agentType}`);
    console.log(`   Command: "${command}"`);
    console.log(`   VM: ${this.vmUrl}`);

    try {
      const createRes = await this._fetch("/api/task", {
        method: "POST",
        body: JSON.stringify({ agent: agentType, command }),
      });

      const taskId = createRes.taskId;
      if (!taskId) {
        throw new Error("VM response missing taskId");
      }

      console.log(`   📋 Task ID: ${taskId}`);

      if (statusCallback) {
        try { await statusCallback(`Sent to OpenClaw (task ${taskId})`); } catch { /* non-fatal */ }
      }

      const result = await this._pollUntilDone(taskId, statusCallback);

      console.log(
        result.success
          ? `   ✅ Completed: ${result.result}`
          : `   ❌ Failed: ${result.error}`,
      );

      return result;
    } catch (err) {
      const msg = err.name === "AbortError" ? "Task was cancelled" : err.message;
      console.error(`   ❌ Error: ${msg}`);
      return { success: false, error: msg };
    } finally {
      this.isBusy = false;
      this._taskAbort = null;
      this._processQueue();
    }
  }

  queueTask(agentType, command, statusCallback) {
    if (this.isBusy) {
      this.taskQueue.push({ agentType, command, statusCallback });
      return this.taskQueue.length;
    }
    this.executeTask(agentType, command, statusCallback).catch((err) => {
      console.error("[OpenClaw] Task error (non-fatal):", err.message);
    });
    return 0;
  }

  stop() {
    if (this._taskAbort) this._taskAbort.abort();
    this.taskQueue = [];
  }

  async healthCheck() {
    if (this.mockMode) return { online: true, mock: true };
    try {
      const data = await this._fetch("/api/health");
      return { online: true, ...data };
    } catch (err) {
      return { online: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Queue processing
  // ---------------------------------------------------------------------------

  _processQueue() {
    if (this.taskQueue.length > 0 && !this.isBusy) {
      const next = this.taskQueue.shift();
      this.executeTask(next.agentType, next.command, next.statusCallback).catch((err) => {
        console.error("[OpenClaw] Queued task error:", err.message);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Mock mode (no VM needed)
  // ---------------------------------------------------------------------------

  async _executeMock(agentType, command, statusCallback) {
    console.log(`\n🧪 [OpenClaw Mock] Simulating task...`);
    console.log(`   Agent: ${agentType}`);
    console.log(`   Command: "${command}"`);

    this.isBusy = true;

    try {
      const pool =
        this.agentDefinitions?.[agentType]?.simResponses || [
          `Completed "${command}" successfully`,
        ];

      if (statusCallback) {
        try { await statusCallback(`🧪 Mock: Processing "${command}"...`); } catch { /* non-fatal */ }
      }

      await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));

      const result = pool[Math.floor(Math.random() * pool.length)];
      const success = Math.random() > 0.05;

      console.log(success ? `   ✅ Mock result: ${result}` : `   ❌ Mock failure`);

      return success
        ? { success: true, result }
        : { success: false, error: "Simulated failure" };
    } finally {
      this.isBusy = false;
      this._processQueue();
    }
  }
}
