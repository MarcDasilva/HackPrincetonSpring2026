import { createClient, SupabaseClient } from '@supabase/supabase-js';

export class WorldStateService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!
    );
  }

  // ============================================
  // World Objects
  // ============================================

  async getObject(objectId: string) {
    const { data, error } = await this.supabase
      .from('world_objects')
      .select('*')
      .eq('id', objectId)
      .single();
    if (error) throw new Error(`Failed to get object: ${error.message}`);
    return data;
  }

  async getObjectsByType(type: string) {
    const { data, error } = await this.supabase
      .from('world_objects')
      .select('*')
      .eq('object_type', type);
    if (error) throw new Error(`Failed to get objects: ${error.message}`);
    return data;
  }

  async createObject(
    name: string,
    objectType: string,
    coords: { x: number; y: number; z: number },
    metadata: any,
    agentId: string
  ) {
    const { data, error } = await this.supabase
      .from('world_objects')
      .insert({
        name,
        object_type: objectType,
        coords,
        metadata,
        last_updated_by: agentId,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create object: ${error.message}`);
    return data;
  }

  async updateObjectState(objectId: string, agentId: string, newState: any) {
    const { data, error } = await this.supabase
      .from('world_objects')
      .update({
        metadata: newState,
        last_updated_by: agentId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', objectId)
      .select()
      .single();
    if (error) throw new Error(`Failed to update world: ${error.message}`);
    return data;
  }

  async deleteObject(objectId: string) {
    const { error } = await this.supabase
      .from('world_objects')
      .delete()
      .eq('id', objectId);
    if (error) throw new Error(`Failed to delete object: ${error.message}`);
  }

  // Subscribe to ALL world changes (insert, update, delete)
  subscribeToWorldChanges(callback: (payload: any) => void) {
    return this.supabase
      .channel('world_updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'world_objects' }, callback)
      .subscribe();
  }

  // ============================================
  // Agent Status
  // ============================================

  async registerAgent(agentId: string, displayName: string, metadata?: any) {
    const { data, error } = await this.supabase
      .from('agent_status')
      .upsert({
        agent_id: agentId,
        display_name: displayName,
        status: 'idle',
        last_heartbeat: new Date().toISOString(),
        metadata,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to register agent: ${error.message}`);
    return data;
  }

  async updateAgentStatus(agentId: string, status: 'idle' | 'busy' | 'offline', currentTask?: string) {
    const { error } = await this.supabase
      .from('agent_status')
      .update({
        status,
        current_task: currentTask ?? null,
        last_heartbeat: new Date().toISOString(),
      })
      .eq('agent_id', agentId);
    if (error) throw new Error(`Failed to update agent status: ${error.message}`);
  }

  async heartbeat(agentId: string) {
    const { error } = await this.supabase
      .from('agent_status')
      .update({ last_heartbeat: new Date().toISOString() })
      .eq('agent_id', agentId);
    if (error) throw new Error(`Heartbeat failed: ${error.message}`);
  }

  async getAllAgentStatuses() {
    const { data, error } = await this.supabase
      .from('agent_status')
      .select('*');
    if (error) throw new Error(`Failed to get agent statuses: ${error.message}`);
    return data;
  }

  subscribeToAgentStatus(callback: (payload: any) => void) {
    return this.supabase
      .channel('agent_status_updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_status' }, callback)
      .subscribe();
  }

  // ============================================
  // Chat Messages
  // ============================================

  async sendMessage(sender: string, content: string, messageType: 'user' | 'agent' | 'system', metadata?: any) {
    const { data, error } = await this.supabase
      .from('chat_messages')
      .insert({
        sender,
        content,
        message_type: messageType,
        metadata,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to send message: ${error.message}`);
    return data;
  }

  async getRecentMessages(limit: number = 50) {
    const { data, error } = await this.supabase
      .from('chat_messages')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to get messages: ${error.message}`);
    return data?.reverse(); // Return in chronological order
  }

  subscribeToChatMessages(callback: (payload: any) => void) {
    return this.supabase
      .channel('chat_messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, callback)
      .subscribe();
  }

  // ============================================
  // Jobs
  // ============================================

  async createJob(jobId: string, payload: any) {
    const { data, error } = await this.supabase
      .from('jobs_history')
      .insert({
        job_id: jobId,
        status: 'pending',
        payload,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create job: ${error.message}`);
    return data;
  }

  async assignJob(jobId: string, agentId: string) {
    const { error } = await this.supabase
      .from('jobs_history')
      .update({
        assigned_agent: agentId,
        status: 'active',
      })
      .eq('job_id', jobId);
    if (error) throw new Error(`Failed to assign job: ${error.message}`);
  }

  async completeJob(jobId: string, result: any) {
    const { error } = await this.supabase
      .from('jobs_history')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result,
      })
      .eq('job_id', jobId);
    if (error) throw new Error(`Failed to complete job: ${error.message}`);
  }

  async failJob(jobId: string, result: any) {
    const { error } = await this.supabase
      .from('jobs_history')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        result,
      })
      .eq('job_id', jobId);
    if (error) throw new Error(`Failed to mark job as failed: ${error.message}`);
  }

  async getJobsByAgent(agentId: string) {
    const { data, error } = await this.supabase
      .from('jobs_history')
      .select('*')
      .eq('assigned_agent', agentId)
      .order('started_at', { ascending: false });
    if (error) throw new Error(`Failed to get jobs: ${error.message}`);
    return data;
  }

  async getPendingJobs() {
    const { data, error } = await this.supabase
      .from('jobs_history')
      .select('*')
      .eq('status', 'pending');
    if (error) throw new Error(`Failed to get pending jobs: ${error.message}`);
    return data;
  }
}