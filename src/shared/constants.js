export const AGENT_IDS = Object.freeze({
  foreman: "foreman",
  miner: "worker-miner",
  builder: "worker-builder",
  forager: "worker-forager",
});

export const WORKER_IDS = Object.freeze([
  AGENT_IDS.miner,
  AGENT_IDS.builder,
  AGENT_IDS.forager,
]);

export const WORKER_ROLES = Object.freeze({
  [AGENT_IDS.miner]: {
    role: "miner",
    displayName: "Miner",
    vmName: "worker-miner",
    strengths: ["mine_ore", "gather_stone", "craft_tools", "craft_torches"],
    style: "concise, practical, underground-aware",
  },
  [AGENT_IDS.builder]: {
    role: "builder",
    displayName: "Builder",
    vmName: "worker-builder",
    strengths: ["expand_storage", "build_base", "craft_chest", "smelt_ore"],
    style: "organized, materials-focused, base-aware",
  },
  [AGENT_IDS.forager]: {
    role: "forager",
    displayName: "Forager",
    vmName: "worker-forager",
    strengths: ["gather_food", "scout", "gather_wood", "farm"],
    style: "field-aware, upbeat, surface-focused",
  },
});

export const JOB_STATUS = Object.freeze({
  pending: "pending",
  running: "running",
  active: "active",
  completed: "completed",
  blocked: "blocked",
  abandoned: "abandoned",
  failed: "failed",
  canceled: "canceled",
});

export const MESSAGE_PROCESSING_STATUS = Object.freeze({
  new: "new",
  processed: "processed",
  ignored: "ignored",
  failed: "failed",
});

export const OUTBOUND_STATUS = Object.freeze({
  pending: "pending",
  delivered: "delivered",
  failed: "failed",
  skipped: "skipped",
});

export const JOB_EVENT_TYPES = Object.freeze({
  created: "created",
  assigned: "assigned",
  claimed: "claimed",
  started: "started",
  progress: "progress",
  completed: "completed",
  blocked: "blocked",
  abandoned: "abandoned",
  failed: "failed",
  released: "released",
  heartbeat: "heartbeat",
});

export const MESSAGE_DIRECTION = Object.freeze({
  inbound: "inbound",
  outbound: "outbound",
  internal: "internal",
});

export const MESSAGE_TYPE = Object.freeze({
  user: "user",
  agent: "agent",
  system: "system",
});

export const WORLD_OBJECT_TYPES = Object.freeze({
  oreVein: "ore_vein",
  chest: "chest",
  base: "base",
  farm: "farm",
  landmark: "landmark",
  storage: "storage",
  resource: "resource",
});

export const DEFAULT_STOCK_TARGETS = Object.freeze([
  { item_name: "cooked_food", target_count: 32, min_count: 12, priority_weight: 2 },
  { item_name: "iron_ingot", target_count: 24, min_count: 8, priority_weight: 2.5 },
  { item_name: "torch", target_count: 64, min_count: 16, priority_weight: 1.5 },
  { item_name: "pickaxe", target_count: 3, min_count: 1, priority_weight: 2 },
  { item_name: "empty_storage_slots", target_count: 54, min_count: 12, priority_weight: 2 },
]);

export const REALTIME_TABLES = Object.freeze([
  "chat_messages",
  "jobs_history",
  "agent_status",
  "world_objects",
  "job_events",
]);
