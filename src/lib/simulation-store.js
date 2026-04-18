import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JOB_STATUS, MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, MESSAGE_TYPE, OUTBOUND_STATUS } from "../shared/constants.js";

const TABLES = ["world_objects", "agent_status", "chat_messages", "jobs_history", "agent_memory", "stock_targets", "job_events"];

function now() {
  return new Date().toISOString();
}

function defaultState() {
  return Object.fromEntries(TABLES.map((table) => [table, []]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class SimulationStore {
  constructor({ filePath = ".simulation/openclaw-state.json", persist = true } = {}) {
    this.filePath = filePath;
    this.persist = persist;
    this.state = defaultState();
    this.events = new EventEmitter();
  }

  async load() {
    if (!this.persist) return this;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.state = { ...defaultState(), ...JSON.parse(raw) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
    return this;
  }

  async save() {
    if (!this.persist) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  async reset(nextState = defaultState()) {
    this.state = { ...defaultState(), ...clone(nextState) };
    await this.save();
  }

  emit(table, event, row) {
    this.events.emit(table, { eventType: event, table, new: clone(row) });
    this.events.emit("*", { eventType: event, table, new: clone(row) });
  }

  subscribe(table, callback) {
    this.events.on(table, callback);
    return { unsubscribe: () => this.events.off(table, callback) };
  }

  async upsertWorldObject(object) {
    const row = {
      id: object.id || randomUUID(),
      dimension: "overworld",
      metadata: {},
      last_updated_by: null,
      updated_at: now(),
      ...object,
    };
    const index = this.state.world_objects.findIndex((item) => item.id === row.id || item.name === row.name);
    if (index >= 0) this.state.world_objects[index] = { ...this.state.world_objects[index], ...row, updated_at: now() };
    else this.state.world_objects.push(row);
    await this.save();
    this.emit("world_objects", index >= 0 ? "UPDATE" : "INSERT", row);
    return clone(row);
  }

  async listWorldObjects(filter = {}) {
    return clone(this.state.world_objects.filter((row) => !filter.object_type || row.object_type === filter.object_type));
  }

  async upsertAgentStatus(agent) {
    const row = {
      display_name: agent.agent_id,
      status: "idle",
      current_task: null,
      last_heartbeat: now(),
      metadata: {},
      ...agent,
    };
    const index = this.state.agent_status.findIndex((item) => item.agent_id === row.agent_id);
    if (index >= 0) this.state.agent_status[index] = { ...this.state.agent_status[index], ...row };
    else this.state.agent_status.push(row);
    await this.save();
    this.emit("agent_status", index >= 0 ? "UPDATE" : "INSERT", row);
    return clone(row);
  }

  async heartbeat(agentId, patch = {}) {
    const agent = this.state.agent_status.find((row) => row.agent_id === agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    Object.assign(agent, patch, { last_heartbeat: now() });
    await this.save();
    this.emit("agent_status", "UPDATE", agent);
    return clone(agent);
  }

  async listAgentStatus() {
    return clone(this.state.agent_status);
  }

  async getAgentStatus(agentId) {
    return clone(this.state.agent_status.find((row) => row.agent_id === agentId) || null);
  }

  async insertChatMessage(message) {
    const row = {
      id: randomUUID(),
      sender: "system",
      message_type: MESSAGE_TYPE.system,
      source_chat: "group_chat",
      direction: MESSAGE_DIRECTION.internal,
      processing_status: MESSAGE_PROCESSING_STATUS.new,
      delivery_status: OUTBOUND_STATUS.skipped,
      metadata: {},
      created_at: now(),
      ...message,
    };
    this.state.chat_messages.push(row);
    await this.save();
    this.emit("chat_messages", "INSERT", row);
    return clone(row);
  }

  async listChatMessages(filter = {}) {
    return clone(this.state.chat_messages.filter((row) => {
      if (filter.direction && row.direction !== filter.direction) return false;
      if (filter.processing_status && row.processing_status !== filter.processing_status) return false;
      if (filter.delivery_status && row.delivery_status !== filter.delivery_status) return false;
      return true;
    }));
  }

  async updateChatMessage(id, patch) {
    const row = this.state.chat_messages.find((message) => message.id === id);
    if (!row) throw new Error(`Unknown chat message ${id}`);
    Object.assign(row, patch);
    await this.save();
    this.emit("chat_messages", "UPDATE", row);
    return clone(row);
  }

  async createJob(job) {
    const row = {
      id: randomUUID(),
      job_id: job.job_id || `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      assigned_agent: null,
      status: JOB_STATUS.pending,
      priority: 0,
      task_brief: {},
      payload: {},
      result: null,
      source: "system",
      started_at: now(),
      updated_at: now(),
      completed_at: null,
      ...job,
    };
    const duplicate = this.state.jobs_history.find((item) => item.job_id === row.job_id);
    if (duplicate) return clone(duplicate);
    this.state.jobs_history.push(row);
    await this.save();
    this.emit("jobs_history", "INSERT", row);
    return clone(row);
  }

  async listJobs(filter = {}) {
    return clone(this.state.jobs_history.filter((row) => {
      if (filter.status && row.status !== filter.status) return false;
      if (filter.assigned_agent && row.assigned_agent !== filter.assigned_agent) return false;
      return true;
    }).sort((a, b) => (b.priority - a.priority) || a.started_at.localeCompare(b.started_at)));
  }

  async getJob(id) {
    return clone(this.state.jobs_history.find((row) => row.id === id || row.job_id === id) || null);
  }

  async claimJobHistory(jobId, agentId, taskBrief) {
    const row = this.state.jobs_history.find((job) => job.id === jobId || job.job_id === jobId);
    if (!row || row.status !== JOB_STATUS.pending || row.assigned_agent) return null;
    row.status = JOB_STATUS.active;
    row.assigned_agent = agentId;
    row.task_brief = taskBrief;
    row.updated_at = now();
    await this.heartbeat(agentId, { status: "busy", current_job_id: row.id, current_task: `${row.kind} ${row.target || ""}`.trim() });
    await this.addJobEvent(row.id, agentId, "assigned", { task_brief: taskBrief });
    await this.save();
    this.emit("jobs_history", "UPDATE", row);
    return clone(row);
  }

  async updateJob(id, patch) {
    const row = this.state.jobs_history.find((job) => job.id === id || job.job_id === id);
    if (!row) throw new Error(`Unknown job ${id}`);
    Object.assign(row, patch, { updated_at: now() });
    if ([JOB_STATUS.completed, JOB_STATUS.failed].includes(row.status) && !row.completed_at) row.completed_at = now();
    await this.save();
    this.emit("jobs_history", "UPDATE", row);
    return clone(row);
  }

  async releaseJobHistory(jobId, agentId, reason) {
    const row = this.state.jobs_history.find((job) => job.id === jobId || job.job_id === jobId);
    if (!row || row.assigned_agent !== agentId || ![JOB_STATUS.active, JOB_STATUS.blocked].includes(row.status)) return null;
    row.status = JOB_STATUS.pending;
    row.assigned_agent = null;
    row.release_reason = reason;
    row.updated_at = now();
    await this.heartbeat(agentId, { status: "idle", current_job_id: null, current_task: null });
    await this.addJobEvent(row.id, agentId, "released", { reason });
    await this.save();
    this.emit("jobs_history", "UPDATE", row);
    return clone(row);
  }

  async addMemory(agentId, memoryType, content) {
    const row = { id: randomUUID(), agent_id: agentId, memory_type: memoryType, content, created_at: now() };
    this.state.agent_memory.push(row);
    await this.save();
    this.emit("agent_memory", "INSERT", row);
    return clone(row);
  }

  async getMemories(agentId, options = {}) {
    const limit = options.limit ?? 10;
    return clone(this.state.agent_memory
      .filter((row) => row.agent_id === agentId && (!options.memory_type || row.memory_type === options.memory_type))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit));
  }

  async upsertStockTarget(target) {
    const index = this.state.stock_targets.findIndex((row) => row.item_name === target.item_name);
    if (index >= 0) this.state.stock_targets[index] = { ...this.state.stock_targets[index], ...target };
    else this.state.stock_targets.push(target);
    await this.save();
    return clone(index >= 0 ? this.state.stock_targets[index] : target);
  }

  async listStockTargets() {
    return clone(this.state.stock_targets);
  }

  async addJobEvent(jobId, agentId, eventType, payload = {}) {
    const row = { id: randomUUID(), job_id: jobId, agent_id: agentId, event_type: eventType, payload, created_at: now() };
    this.state.job_events.push(row);
    await this.save();
    this.emit("job_events", "INSERT", row);
    return clone(row);
  }

  async getState() {
    return clone(this.state);
  }
}
