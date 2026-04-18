import { z } from "zod";
import {
  AGENT_IDS,
  JOB_STATUS,
  MESSAGE_DIRECTION,
  MESSAGE_PROCESSING_STATUS,
  MESSAGE_TYPE,
  OUTBOUND_STATUS,
  WORKER_IDS,
  WORLD_OBJECT_TYPES,
} from "./constants.js";
import { JOB_KINDS } from "./job-types.js";

export const workerIdSchema = z.enum(WORKER_IDS);

export const positionSchema = z.object({
  dimension: z.string().default("overworld"),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  z: z.number().nullable().optional(),
});

export const coordsSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const worldObjectSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string(),
  object_type: z.string().default(WORLD_OBJECT_TYPES.landmark),
  dimension: z.string().default("overworld"),
  coords: coordsSchema,
  metadata: z.record(z.any()).default({}),
  last_updated_by: z.string().nullable().optional(),
  updated_at: z.string().optional(),
});

export const agentStatusSchema = z.object({
  agent_id: z.string(),
  display_name: z.string(),
  role: z.string(),
  vm_name: z.string().nullable().optional(),
  status: z.string(),
  current_job_id: z.string().uuid().nullable().optional(),
  current_task: z.string().nullable().optional(),
  last_heartbeat: z.string().optional(),
  health: z.number().nullable().optional(),
  food: z.number().int().nullable().optional(),
  dimension: z.string().nullable().optional(),
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  z: z.number().nullable().optional(),
  metadata: z.record(z.any()).default({}),
});

export const inventoryItemSchema = z.object({
  item_name: z.string(),
  count: z.number().int().nonnegative(),
  slot: z.number().int().nullable().optional(),
});

export const taskBriefSchema = z.object({
  objective: z.string().min(1),
  kind: z.nativeEnum(JOB_KINDS).or(z.string().min(1)),
  target: z.string().nullable().optional(),
  quantity: z.number().int().positive().nullable().optional(),
  assigned_agent_id: z.string(),
  success_criteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  relevant_context: z.object({
    worker_state: z.record(z.any()).default({}),
    inventory: z.array(inventoryItemSchema).default([]),
    world_objects: z.array(worldObjectSchema.partial()).default([]),
    memories: z.array(z.record(z.any())).default([]),
    stock: z.array(z.record(z.any())).default([]),
    recent_human_override: z.record(z.any()).nullable().optional(),
  }).default({}),
});

export const jobHistorySchema = z.object({
  id: z.string().uuid().optional(),
  job_id: z.string().optional(),
  kind: z.string(),
  target: z.string().nullable().optional(),
  quantity: z.number().int().nullable().optional(),
  priority: z.number().default(0),
  status: z.string().default(JOB_STATUS.pending),
  assigned_agent: z.string().nullable().optional(),
  source: z.string().default("system"),
  task_brief: taskBriefSchema.partial().or(z.record(z.any())).default({}),
  payload: z.record(z.any()).default({}),
  result: z.record(z.any()).nullable().optional(),
  release_reason: z.string().nullable().optional(),
});

export const chatMessageSchema = z.object({
  id: z.string().uuid().optional(),
  sender: z.string(),
  message_type: z.nativeEnum(MESSAGE_TYPE).or(z.string()),
  content: z.string().min(1),
  source_chat: z.string().default("group_chat"),
  direction: z.nativeEnum(MESSAGE_DIRECTION).or(z.string()),
  processing_status: z.nativeEnum(MESSAGE_PROCESSING_STATUS).or(z.string()).default(MESSAGE_PROCESSING_STATUS.new),
  delivery_status: z.nativeEnum(OUTBOUND_STATUS).or(z.string()).default(OUTBOUND_STATUS.skipped),
  metadata: z.record(z.any()).default({}),
});

export const agentMemorySchema = z.object({
  id: z.string().uuid().optional(),
  agent_id: z.string(),
  memory_type: z.string(),
  content: z.record(z.any()),
  created_at: z.string().optional(),
});

export const foremanPlanSchema = z.object({
  assignments: z.array(z.object({
    job_id: z.string().uuid(),
    agent_id: z.string(),
    task_brief: taskBriefSchema,
    rationale: z.string().optional(),
  })).default([]),
  priority_updates: z.array(z.object({
    job_id: z.string().uuid(),
    priority: z.number(),
    reason: z.string().optional(),
  })).default([]),
  plan_message: z.string().nullable().optional(),
});

export const workerMessageSchema = z.object({
  public_text: z.string().min(1),
  suggestion: z.string().nullable().optional(),
});

export function validateTaskBrief(brief) {
  return taskBriefSchema.parse(brief);
}

export function isWorkerAgent(agentId) {
  return WORKER_IDS.includes(agentId);
}

export function getWorkerRole(agentId) {
  if (agentId === AGENT_IDS.miner) return "miner";
  if (agentId === AGENT_IDS.builder) return "builder";
  if (agentId === AGENT_IDS.forager) return "forager";
  return null;
}
