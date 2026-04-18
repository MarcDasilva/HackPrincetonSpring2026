import test from "node:test";
import assert from "node:assert/strict";
import { chatMessageSchema, taskBriefSchema, worldObjectSchema } from "../src/shared/schemas.js";

test("worldObjectSchema matches persistent-memory world_objects", () => {
  const object = worldObjectSchema.parse({
    name: "Iron Ore Vein A",
    object_type: "ore_vein",
    coords: { x: 50, y: 12, z: 100 },
    metadata: { ore_type: "iron" },
  });
  assert.equal(object.dimension, "overworld");
});

test("chatMessageSchema supports inbound user commands", () => {
  const message = chatMessageSchema.parse({
    sender: "user",
    message_type: "user",
    content: "mine iron",
    direction: "inbound",
  });
  assert.equal(message.processing_status, "new");
});

test("taskBriefSchema enforces narrow assigned agent context", () => {
  const brief = taskBriefSchema.parse({
    objective: "Mine iron",
    kind: "mine_ore",
    target: "iron_ore",
    quantity: 10,
    assigned_agent_id: "worker-miner",
    relevant_context: {
      worker_state: { agent_id: "worker-miner" },
      world_objects: [{ name: "Iron", object_type: "ore_vein", coords: { x: 1, y: 2, z: 3 } }],
    },
  });
  assert.equal(brief.relevant_context.world_objects.length, 1);
});
