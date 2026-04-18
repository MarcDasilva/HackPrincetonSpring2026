// src/types/schemas.ts

export interface JobStatus {
  job_id: string;
  assigned_agent: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  expires_at: number; // Redis TTL timestamp
}

export interface WorldObject {
  id: string;
  name: string;
  object_type: 'chest' | 'ore_vein' | 'base' | string;
  coords: { x: number; y: number; z: number };
  metadata: Record<string, any>;
  last_updated_by: string | null;
  updated_at: string;
}

export interface AgentStatus {
  agent_id: string;
  display_name: string | null;
  status: 'idle' | 'busy' | 'offline';
  current_task: string | null;
  last_heartbeat: string;
  metadata: Record<string, any> | null;
}

export interface AgentMemory {
  id: string;
  agent_id: string;
  memory_type: 'observation' | 'plan' | 'reflection' | 'note';
  content: Record<string, any>;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  sender: string;
  message_type: 'user' | 'agent' | 'system';
  content: string;
  metadata: Record<string, any> | null;
  created_at: string;
}

export interface JobRecord {
  id: string;
  job_id: string;
  assigned_agent: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  payload: Record<string, any>;
  result: Record<string, any> | null;
}