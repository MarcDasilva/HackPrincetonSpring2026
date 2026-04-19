import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  Coords,
  WorldEvent,
  WorldEventType,
  TaskRun,
  TaskType,
  KnownLocation,
  LocationType,
  LocationStatus,
  TaskContext,
  AgentMemory,
} from '../types/schemas';

const TASK_TYPE_KEYWORDS: Record<TaskType, string[]> = {
  mine: ['mine', 'dig', 'ore', 'cave', 'underground', 'quarry', 'excavate', 'tunnel'],
  build: ['build', 'construct', 'place', 'create', 'house', 'base', 'wall', 'roof', 'shelter', 'structure'],
  explore: ['explore', 'find', 'search', 'scout', 'discover', 'look', 'wander', 'survey'],
  gather: ['gather', 'collect', 'chop', 'harvest', 'farm', 'pick', 'wood', 'food'],
  craft: ['craft', 'make', 'smelt', 'brew', 'enchant', 'forge'],
  plan: ['plan', 'strategy', 'organize', 'coordinate', 'prepare'],
  fight: ['fight', 'kill', 'attack', 'defend', 'mob', 'monster', 'creeper', 'zombie', 'skeleton'],
  travel: ['go to', 'travel', 'walk', 'run', 'return', 'head to', 'navigate'],
  other: [],
};

const LOCATION_TYPE_FOR_TASK: Record<TaskType, LocationType[]> = {
  mine: ['cave', 'ore_deposit'],
  build: ['base', 'structure', 'landmark'],
  explore: ['cave', 'village', 'landmark', 'structure', 'nether_portal'],
  gather: ['farm', 'village', 'water'],
  craft: ['base', 'structure'],
  plan: [],
  fight: ['danger_zone'],
  travel: ['base', 'village', 'landmark', 'nether_portal'],
  other: [],
};

export class PersistentMemoryService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!
    );
  }

  // ============================================================================
  // TASK TYPE INFERENCE
  // ============================================================================

  inferTaskType(command: string): TaskType {
    const lower = command.toLowerCase();
    for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
      if (type === 'other') continue;
      if (keywords.some((kw) => lower.includes(kw))) {
        return type as TaskType;
      }
    }
    return 'other';
  }

  // ============================================================================
  // WORLD EVENTS — track everything that happens in the world
  // ============================================================================

  async recordWorldEvent(event: {
    eventType: WorldEventType;
    objectType?: string;
    objectName?: string;
    objectId?: string;
    coords?: Coords;
    causedBy?: string;
    agentId?: string;
    description?: string;
    metadata?: Record<string, any>;
  }): Promise<WorldEvent> {
    const { data, error } = await this.supabase
      .from('world_events')
      .insert({
        event_type: event.eventType,
        object_type: event.objectType ?? null,
        object_name: event.objectName ?? null,
        object_id: event.objectId ?? null,
        coords: event.coords ?? null,
        caused_by: event.causedBy ?? null,
        agent_id: event.agentId ?? null,
        description: event.description ?? null,
        metadata: event.metadata ?? {},
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to record world event: ${error.message}`);

    if (event.eventType === 'destroyed' && event.coords) {
      await this.markNearbyLocationsDestroyed(event.coords, event.objectType, event.causedBy);
    }
    if (event.eventType === 'depleted' && event.objectId) {
      await this.updateLocationStatus(event.objectId, 'depleted');
    }

    return data;
  }

  async getRecentWorldEvents(limit: number = 20, since?: string): Promise<WorldEvent[]> {
    let query = this.supabase
      .from('world_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (since) {
      query = query.gte('created_at', since);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to get world events: ${error.message}`);
    return data ?? [];
  }

  async getWorldEventsByType(eventType: WorldEventType, limit: number = 20): Promise<WorldEvent[]> {
    const { data, error } = await this.supabase
      .from('world_events')
      .select('*')
      .eq('event_type', eventType)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to get world events: ${error.message}`);
    return data ?? [];
  }

  subscribeToWorldEvents(callback: (event: WorldEvent) => void) {
    return this.supabase
      .channel('world_events_realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'world_events' }, (payload) => {
        callback(payload.new as WorldEvent);
      })
      .subscribe();
  }

  // ============================================================================
  // TASK RUNS — track every task execution for recall
  // ============================================================================

  async startTaskRun(agentId: string, command: string, taskType?: TaskType): Promise<TaskRun> {
    const resolvedType = taskType ?? this.inferTaskType(command);
    const { data, error } = await this.supabase
      .from('task_runs')
      .insert({
        task_type: resolvedType,
        command,
        agent_id: agentId,
        status: 'active',
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to start task run: ${error.message}`);
    return data;
  }

  async completeTaskRun(taskId: string, outcome: {
    result: string;
    locationsDiscovered?: Array<{ name: string; coords: Coords; type: string }>;
    resourcesGathered?: Record<string, number>;
    routeTaken?: Coords[];
  }): Promise<TaskRun> {
    const { data, error } = await this.supabase
      .from('task_runs')
      .update({
        status: 'completed',
        outcome: outcome.result,
        locations_discovered: outcome.locationsDiscovered ?? [],
        resources_gathered: outcome.resourcesGathered ?? {},
        route_taken: outcome.routeTaken ?? [],
        completed_at: new Date().toISOString(),
      })
      .eq('id', taskId)
      .select()
      .single();
    if (error) throw new Error(`Failed to complete task run: ${error.message}`);

    if (outcome.locationsDiscovered?.length) {
      for (const loc of outcome.locationsDiscovered) {
        await this.recordLocation({
          name: loc.name,
          locationType: loc.type as LocationType,
          coords: loc.coords,
          discoveredBy: data.agent_id,
          discoveredDuring: taskId,
          description: `Discovered during: "${data.command}"`,
        });
      }
    }

    return data;
  }

  async failTaskRun(taskId: string, reason: string): Promise<void> {
    const { error } = await this.supabase
      .from('task_runs')
      .update({
        status: 'failed',
        outcome: reason,
        completed_at: new Date().toISOString(),
      })
      .eq('id', taskId);
    if (error) throw new Error(`Failed to mark task as failed: ${error.message}`);
  }

  async recallSimilarTasks(command: string, limit: number = 5): Promise<TaskRun[]> {
    const taskType = this.inferTaskType(command);

    const { data: byType, error: err1 } = await this.supabase
      .from('task_runs')
      .select('*')
      .eq('task_type', taskType)
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (err1) throw new Error(`Failed to recall tasks: ${err1.message}`);

    const keywords = command.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const ftsQuery = keywords.join(' | ');
    const { data: byText } = await this.supabase
      .from('task_runs')
      .select('*')
      .textSearch('command_tsv', ftsQuery, { type: 'plain' })
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(limit);

    const seen = new Set<string>();
    const merged: TaskRun[] = [];
    for (const task of [...(byType ?? []), ...(byText ?? [])]) {
      if (!seen.has(task.id)) {
        seen.add(task.id);
        merged.push(task);
      }
    }

    return merged.slice(0, limit);
  }

  async getTaskRunsByAgent(agentId: string, limit: number = 10): Promise<TaskRun[]> {
    const { data, error } = await this.supabase
      .from('task_runs')
      .select('*')
      .eq('agent_id', agentId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to get task runs: ${error.message}`);
    return data ?? [];
  }

  // ============================================================================
  // KNOWN LOCATIONS — persistent spatial memory
  // ============================================================================

  async recordLocation(loc: {
    name: string;
    locationType: LocationType;
    coords: Coords;
    discoveredBy?: string;
    discoveredDuring?: string;
    description?: string;
    tags?: string[];
    metadata?: Record<string, any>;
  }): Promise<KnownLocation> {
    const existing = await this.findNearbyLocations(loc.coords, 10);
    const duplicate = existing.find(
      (e) => e.location_type === loc.locationType && e.name.toLowerCase() === loc.name.toLowerCase()
    );
    if (duplicate) {
      const { data } = await this.supabase
        .from('known_locations')
        .update({
          coords: loc.coords,
          description: loc.description ?? duplicate.description,
          updated_at: new Date().toISOString(),
        })
        .eq('id', duplicate.id)
        .select()
        .single();
      return data ?? duplicate;
    }

    const { data, error } = await this.supabase
      .from('known_locations')
      .insert({
        name: loc.name,
        location_type: loc.locationType,
        coords: loc.coords,
        discovered_by: loc.discoveredBy ?? null,
        discovered_during: loc.discoveredDuring ?? null,
        description: loc.description ?? null,
        tags: loc.tags ?? [],
        metadata: loc.metadata ?? {},
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to record location: ${error.message}`);
    return data;
  }

  async getLocationsForTaskType(taskType: TaskType, limit: number = 10): Promise<KnownLocation[]> {
    const relevantTypes = LOCATION_TYPE_FOR_TASK[taskType] ?? [];
    if (relevantTypes.length === 0) return [];

    const { data, error } = await this.supabase
      .from('known_locations')
      .select('*')
      .in('location_type', relevantTypes)
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to get locations: ${error.message}`);
    return data ?? [];
  }

  async findNearbyLocations(coords: Coords, radius: number = 100): Promise<KnownLocation[]> {
    const { data, error } = await this.supabase
      .rpc('find_nearby_locations', {
        target_x: coords.x,
        target_y: coords.y,
        target_z: coords.z,
        radius,
      });
    if (error) {
      const { data: fallback, error: err2 } = await this.supabase
        .from('known_locations')
        .select('*')
        .eq('status', 'active');
      if (err2) return [];
      return (fallback ?? []).filter((loc: KnownLocation) => {
        const dx = loc.coords.x - coords.x;
        const dy = loc.coords.y - coords.y;
        const dz = loc.coords.z - coords.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
      });
    }
    return data ?? [];
  }

  async updateLocationStatus(locationId: string, status: LocationStatus): Promise<void> {
    const { error } = await this.supabase
      .from('known_locations')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', locationId);
    if (error) throw new Error(`Failed to update location status: ${error.message}`);
  }

  async getAllActiveLocations(): Promise<KnownLocation[]> {
    const { data, error } = await this.supabase
      .from('known_locations')
      .select('*')
      .eq('status', 'active')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(`Failed to get locations: ${error.message}`);
    return data ?? [];
  }

  private async markNearbyLocationsDestroyed(
    coords: Coords,
    objectType?: string,
    causedBy?: string
  ): Promise<void> {
    const nearby = await this.findNearbyLocations(coords, 15);
    for (const loc of nearby) {
      if (objectType && loc.location_type !== objectType) continue;
      await this.updateLocationStatus(loc.id, 'destroyed');
    }
  }

  // ============================================================================
  // CROSS-AGENT SYNC — what have other agents been doing?
  // ============================================================================

  async getOtherAgentCompletedTasks(excludeAgentId: string, limit: number = 10): Promise<TaskRun[]> {
    const { data, error } = await this.supabase
      .from('task_runs')
      .select('*')
      .neq('agent_id', excludeAgentId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Failed to get other agent tasks: ${error.message}`);
    return data ?? [];
  }

  async getWorldChangeSummary(since: string): Promise<string> {
    const events = await this.getRecentWorldEvents(50, since);
    if (events.length === 0) return 'No world changes since last check.';

    const destroyed = events.filter((e) => e.event_type === 'destroyed');
    const created = events.filter((e) => e.event_type === 'created');
    const modified = events.filter((e) => e.event_type === 'modified');
    const discovered = events.filter((e) => e.event_type === 'discovered');

    const lines: string[] = [];
    if (destroyed.length > 0) {
      lines.push(`DESTROYED: ${destroyed.map((e) => `${e.object_name ?? e.object_type} at ${JSON.stringify(e.coords)} (by ${e.caused_by})`).join('; ')}`);
    }
    if (created.length > 0) {
      lines.push(`CREATED: ${created.map((e) => `${e.object_name ?? e.object_type} at ${JSON.stringify(e.coords)}`).join('; ')}`);
    }
    if (modified.length > 0) {
      lines.push(`MODIFIED: ${modified.map((e) => `${e.object_name ?? e.object_type} — ${e.description}`).join('; ')}`);
    }
    if (discovered.length > 0) {
      lines.push(`DISCOVERED: ${discovered.map((e) => `${e.object_name ?? e.object_type} at ${JSON.stringify(e.coords)}`).join('; ')}`);
    }

    return lines.join('\n');
  }

  // ============================================================================
  // CONTEXT BUILDER — the main thing agents call before acting
  // ============================================================================

  async buildTaskContext(agentId: string, command: string): Promise<TaskContext> {
    const taskType = this.inferTaskType(command);

    const [
      recentMemories,
      similarPastTasks,
      relevantLocations,
      recentWorldEvents,
      otherAgentActivity,
    ] = await Promise.all([
      this.getAgentMemories(agentId, 10),
      this.recallSimilarTasks(command, 5),
      this.getLocationsForTaskType(taskType, 10),
      this.getRecentWorldEvents(10),
      this.getAgentStatuses(agentId),
    ]);

    return {
      recentMemories,
      similarPastTasks,
      relevantLocations,
      recentWorldEvents,
      otherAgentActivity,
    };
  }

  async buildContextPrompt(agentId: string, command: string): Promise<string> {
    const ctx = await this.buildTaskContext(agentId, command);
    const sections: string[] = [];

    if (ctx.similarPastTasks.length > 0) {
      sections.push('=== SIMILAR PAST TASKS ===');
      for (const task of ctx.similarPastTasks) {
        let line = `[${task.task_type}] "${task.command}" → ${task.outcome ?? 'no outcome recorded'}`;
        if (task.locations_discovered?.length > 0) {
          line += ` | Found: ${task.locations_discovered.map((l) => `${l.name} at (${l.coords.x},${l.coords.y},${l.coords.z})`).join(', ')}`;
        }
        if (task.resources_gathered && Object.keys(task.resources_gathered).length > 0) {
          line += ` | Gathered: ${Object.entries(task.resources_gathered).map(([k, v]) => `${v}x ${k}`).join(', ')}`;
        }
        sections.push(line);
      }
    }

    if (ctx.relevantLocations.length > 0) {
      sections.push('\n=== KNOWN LOCATIONS ===');
      for (const loc of ctx.relevantLocations) {
        sections.push(`[${loc.location_type}] "${loc.name}" at (${loc.coords.x},${loc.coords.y},${loc.coords.z}) — ${loc.status}${loc.description ? ` — ${loc.description}` : ''}`);
      }
    }

    if (ctx.recentWorldEvents.length > 0) {
      sections.push('\n=== RECENT WORLD EVENTS ===');
      for (const evt of ctx.recentWorldEvents) {
        sections.push(`[${evt.event_type}] ${evt.object_name ?? evt.object_type ?? 'unknown'} ${evt.coords ? `at (${evt.coords.x},${evt.coords.y},${evt.coords.z})` : ''} ${evt.caused_by ? `(by ${evt.caused_by})` : ''} — ${evt.description ?? ''}`);
      }
    }

    if (ctx.recentMemories.length > 0) {
      sections.push('\n=== AGENT MEMORIES ===');
      for (const mem of ctx.recentMemories) {
        const importance = mem.importance >= 8 ? '⚠️ ' : '';
        sections.push(`${importance}[${mem.memory_type}] ${JSON.stringify(mem.content)}`);
      }
    }

    if (ctx.otherAgentActivity.length > 0) {
      sections.push('\n=== OTHER AGENTS ===');
      for (const agent of ctx.otherAgentActivity) {
        sections.push(`${agent.display_name ?? agent.agent_id}: ${agent.status}${agent.current_task ? ` — working on: ${agent.current_task}` : ''}`);
      }
    }

    if (sections.length === 0) {
      return 'No prior context available. This is a fresh start.';
    }

    return sections.join('\n');
  }

  // ============================================================================
  // DESTRUCTION HANDLING — when things get blown up
  // ============================================================================

  async recordDestruction(params: {
    objectName: string;
    objectType: string;
    coords: Coords;
    causedBy: string;
    agentId?: string;
    objectId?: string;
  }): Promise<void> {
    await this.recordWorldEvent({
      eventType: 'destroyed',
      objectType: params.objectType,
      objectName: params.objectName,
      objectId: params.objectId,
      coords: params.coords,
      causedBy: params.causedBy,
      agentId: params.agentId,
      description: `${params.objectName} was destroyed by ${params.causedBy} at (${params.coords.x}, ${params.coords.y}, ${params.coords.z})`,
    });

    if (params.objectId) {
      try {
        await this.supabase
          .from('world_objects')
          .update({
            metadata: { destroyed: true, destroyed_by: params.causedBy, destroyed_at: new Date().toISOString() },
            updated_at: new Date().toISOString(),
          })
          .eq('id', params.objectId);
      } catch (_) {}
    }
  }

  async recordDiscovery(params: {
    name: string;
    objectType: string;
    locationType: LocationType;
    coords: Coords;
    agentId: string;
    taskId?: string;
    description?: string;
  }): Promise<KnownLocation> {
    await this.recordWorldEvent({
      eventType: 'discovered',
      objectType: params.objectType,
      objectName: params.name,
      coords: params.coords,
      agentId: params.agentId,
      description: params.description ?? `${params.agentId} discovered ${params.name}`,
    });

    return this.recordLocation({
      name: params.name,
      locationType: params.locationType,
      coords: params.coords,
      discoveredBy: params.agentId,
      discoveredDuring: params.taskId,
      description: params.description,
    });
  }

  // ============================================================================
  // HELPERS — internal Supabase queries
  // ============================================================================

  private async getAgentMemories(agentId: string, limit: number): Promise<AgentMemory[]> {
    const { data, error } = await this.supabase
      .from('agent_memory')
      .select('*')
      .eq('agent_id', agentId)
      .order('importance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data ?? [];
  }

  private async getAgentStatuses(excludeAgentId: string) {
    const { data, error } = await this.supabase
      .from('agent_status')
      .select('*')
      .neq('agent_id', excludeAgentId)
      .neq('status', 'offline');
    if (error) return [];
    return data ?? [];
  }
}
