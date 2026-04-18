import { AGENT_IDS, DEFAULT_STOCK_TARGETS, MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, MESSAGE_TYPE, OUTBOUND_STATUS } from "../shared/constants.js";

export async function seedDemo(store) {
  await store.reset();
  for (const target of DEFAULT_STOCK_TARGETS) await store.upsertStockTarget(target);

  await store.upsertWorldObject({
    name: "Base Camp Alpha",
    object_type: "base",
    coords: { x: 0, y: 64, z: 0 },
    metadata: { structures: ["furnace", "workbench"], stock: { raw_iron: 6, coal: 8, cooked_food: 4, torch: 8, pickaxe: 0 } },
    last_updated_by: "foreman",
  });
  await store.upsertWorldObject({
    name: "Iron Ore Vein A",
    object_type: "ore_vein",
    coords: { x: 48, y: 12, z: 96 },
    metadata: { ore_type: "iron", blocks: 12, status: "intact" },
    last_updated_by: AGENT_IDS.miner,
  });
  await store.upsertWorldObject({
    name: "Base Storage Chest",
    object_type: "chest",
    coords: { x: 2, y: 64, z: 1 },
    metadata: { empty_slots: 4, items: [{ item_name: "cobblestone", count: 64 }, { item_name: "oak_log", count: 12 }] },
    last_updated_by: AGENT_IDS.builder,
  });
  await store.upsertWorldObject({
    name: "Surface Farm",
    object_type: "farm",
    coords: { x: -24, y: 66, z: 18 },
    metadata: { crop: "wheat", food_available: true, status: "ready" },
    last_updated_by: AGENT_IDS.forager,
  });

  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.miner,
    display_name: "Miner",
    role: "miner",
    vm_name: "worker-miner",
    status: "idle",
    current_task: null,
    health: 18,
    food: 14,
    dimension: "overworld",
    x: 45,
    y: 12,
    z: 90,
    metadata: { inventory: [{ item_name: "iron_pickaxe", count: 1 }], empty_inventory_slots: 8 },
  });
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.builder,
    display_name: "Builder",
    role: "builder",
    vm_name: "worker-builder",
    status: "idle",
    current_task: null,
    health: 20,
    food: 18,
    dimension: "overworld",
    x: 1,
    y: 64,
    z: 2,
    metadata: { inventory: [{ item_name: "oak_planks", count: 32 }], empty_inventory_slots: 12 },
  });
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.forager,
    display_name: "Forager",
    role: "forager",
    vm_name: "worker-forager",
    status: "idle",
    current_task: null,
    health: 20,
    food: 16,
    dimension: "overworld",
    x: -20,
    y: 66,
    z: 16,
    metadata: { inventory: [], empty_inventory_slots: 20 },
  });

  await store.addMemory(AGENT_IDS.miner, "observation", { text: "Iron vein is near current tunnel.", location: { x: 48, y: 12, z: 96 } });
  await store.addMemory(AGENT_IDS.builder, "plan", { text: "Storage is nearly full; add a chest beside base storage." });
  await store.addMemory(AGENT_IDS.forager, "observation", { text: "Farm is ready and food stock is below target." });

  await store.insertChatMessage({
    sender: "user",
    message_type: MESSAGE_TYPE.user,
    content: "Need iron, food, and more storage. Team, handle it.",
    source_chat: "simulation-group",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: { intent: "demo_multi_goal" },
  });
}
