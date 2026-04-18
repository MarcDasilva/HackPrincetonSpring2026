import { createClient } from "@supabase/supabase-js";
import { DEFAULT_STOCK_TARGETS, JOB_STATUS } from "../shared/constants.js";
import { SimulationStore } from "./simulation-store.js";
import { withRetry } from "./logger.js";

export class SupabaseStateStore {
  constructor(config) {
    this.client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  subscribe(table, callback) {
    const channel = this.client
      .channel(`openclaw:${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, callback)
      .subscribe();
    return { unsubscribe: () => this.client.removeChannel(channel) };
  }

  async upsertWorldObject(object) {
    const { data, error } = await this.client.from("world_objects").upsert(object).select().single();
    if (error) throw error;
    return data;
  }

  async listWorldObjects(filter = {}) {
    let query = this.client.from("world_objects").select("*");
    if (filter.object_type) query = query.eq("object_type", filter.object_type);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async upsertAgentStatus(agent) {
    const { data, error } = await this.client.from("agent_status").upsert(agent, { onConflict: "agent_id" }).select().single();
    if (error) throw error;
    return data;
  }

  async heartbeat(agentId, patch = {}) {
    const { data, error } = await this.client
      .from("agent_status")
      .update({ ...patch, last_heartbeat: new Date().toISOString() })
      .eq("agent_id", agentId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async listAgentStatus() {
    const { data, error } = await this.client.from("agent_status").select("*");
    if (error) throw error;
    return data || [];
  }

  async getAgentStatus(agentId) {
    const { data, error } = await this.client.from("agent_status").select("*").eq("agent_id", agentId).maybeSingle();
    if (error) throw error;
    return data;
  }

  async insertChatMessage(message) {
    const { data, error } = await this.client.from("chat_messages").insert(message).select().single();
    if (error) throw error;
    return data;
  }

  async listChatMessages(filter = {}) {
    let query = this.client.from("chat_messages").select("*").order("created_at", { ascending: true });
    if (filter.direction) query = query.eq("direction", filter.direction);
    if (filter.processing_status) query = query.eq("processing_status", filter.processing_status);
    if (filter.delivery_status) query = query.eq("delivery_status", filter.delivery_status);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async updateChatMessage(id, patch) {
    const { data, error } = await this.client.from("chat_messages").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async createJob(job) {
    const { data, error } = await this.client.from("jobs_history").insert(job).select().single();
    if (error) throw error;
    return data;
  }

  async listJobs(filter = {}) {
    let query = this.client.from("jobs_history").select("*").order("priority", { ascending: false }).order("started_at", { ascending: true });
    if (filter.status) query = query.eq("status", filter.status);
    if (filter.assigned_agent) query = query.eq("assigned_agent", filter.assigned_agent);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async getJob(id) {
    const { data, error } = await this.client.from("jobs_history").select("*").or(`id.eq.${id},job_id.eq.${id}`).maybeSingle();
    if (error) throw error;
    return data;
  }

  async claimJobHistory(jobId, agentId, taskBrief) {
    const { data, error } = await this.client.rpc("claim_job_history", {
      p_job_id: jobId,
      p_agent_id: agentId,
      p_task_brief: taskBrief,
    });
    if (error) {
      if (error.code === "P0001") return null;
      throw error;
    }
    return data;
  }

  async releaseJobHistory(jobId, agentId, reason) {
    const { data, error } = await this.client.rpc("release_job_history", {
      p_job_id: jobId,
      p_agent_id: agentId,
      p_release_reason: reason,
    });
    if (error) throw error;
    return data;
  }

  async updateJob(id, patch) {
    const { data, error } = await this.client.from("jobs_history").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return data;
  }

  async addMemory(agentId, memoryType, content) {
    const { data, error } = await this.client
      .from("agent_memory")
      .insert({ agent_id: agentId, memory_type: memoryType, content })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getMemories(agentId, options = {}) {
    let query = this.client.from("agent_memory").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }).limit(options.limit ?? 10);
    if (options.memory_type) query = query.eq("memory_type", options.memory_type);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async upsertStockTarget(target) {
    const { data, error } = await this.client.from("stock_targets").upsert(target, { onConflict: "item_name" }).select().single();
    if (error) throw error;
    return data;
  }

  async listStockTargets() {
    const { data, error } = await this.client.from("stock_targets").select("*");
    if (error) throw error;
    return data || [];
  }

  async addJobEvent(jobId, agentId, eventType, payload = {}) {
    const { data, error } = await this.client
      .from("job_events")
      .insert({ job_id: jobId, agent_id: agentId, event_type: eventType, payload })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

export async function createStateStore(config, { forceSimulation = false } = {}) {
  if (forceSimulation || !config.supabase.url || !config.supabase.serviceRoleKey) {
    const store = new SimulationStore({ filePath: config.simulationDbPath });
    await store.load();
    return store;
  }
  return new SupabaseStateStore(config);
}

export async function ensureDefaultStockTargets(store) {
  await Promise.all(DEFAULT_STOCK_TARGETS.map((target) => withRetry(() => store.upsertStockTarget(target))));
}

export async function markJobComplete(store, job, agentId, result) {
  const updated = await store.updateJob(job.id, { status: JOB_STATUS.completed, result, completed_at: new Date().toISOString() });
  await store.heartbeat(agentId, { status: "idle", current_job_id: null, current_task: null });
  await store.addJobEvent(job.id, agentId, "completed", result);
  return updated;
}
