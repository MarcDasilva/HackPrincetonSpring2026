import { createClient, SupabaseClient } from '@supabase/supabase-js';

type MemoryType = 'observation' | 'plan' | 'reflection' | 'note';

export class AgentMemoryService {
  private supabase: SupabaseClient;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_KEY!
    );
  }

  /**
   * Store a memory for an agent.
   * Example: agent observes iron ore at a location, stores it for later recall.
   */
  async addMemory(agentId: string, type: MemoryType, content: any) {
    const { data, error } = await this.supabase
      .from('agent_memory')
      .insert({
        agent_id: agentId,
        memory_type: type,
        content,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to add memory: ${error.message}`);
    return data;
  }

  /**
   * Get recent memories for an agent, optionally filtered by type.
   * Useful for building context before an agent acts.
   */
  async getMemories(agentId: string, type?: MemoryType, limit: number = 20) {
    let query = this.supabase
      .from('agent_memory')
      .select('*')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (type) {
      query = query.eq('memory_type', type);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Failed to get memories: ${error.message}`);
    return data;
  }

  /**
   * Build a context string from recent memories to inject into an agent's prompt.
   * This is what you'd pass into the LLM so the agent "remembers" things.
   */
  async buildContextForAgent(agentId: string, limit: number = 10): Promise<string> {
    const memories = await this.getMemories(agentId, undefined, limit);

    if (!memories || memories.length === 0) {
      return 'No prior memories.';
    }

    return memories
      .reverse() // chronological order
      .map((m) => `[${m.memory_type}] ${JSON.stringify(m.content)}`)
      .join('\n');
  }

  /**
   * Clear all memories for an agent. Useful for resets during testing.
   */
  async clearMemories(agentId: string) {
    const { error } = await this.supabase
      .from('agent_memory')
      .delete()
      .eq('agent_id', agentId);
    if (error) throw new Error(`Failed to clear memories: ${error.message}`);
  }
}