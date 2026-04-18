import { loadEnv } from "../config/env.js";
import { createStateStore } from "../lib/supabase.js";

const config = loadEnv({ ...process.env, PHOTON_MODE: "simulation" });
const store = await createStateStore(config, { forceSimulation: true });
const state = await store.getState();
const jobs = state.jobs_history;
const required = {
  "worker-miner": "mine_ore",
  "worker-builder": "expand_storage",
  "worker-forager": "gather_food",
};
for (const [agent, kind] of Object.entries(required)) {
  const match = jobs.find((job) => job.assigned_agent === agent && job.kind === kind);
  if (!match) {
    console.error(`Missing expected assignment: ${agent} -> ${kind}`);
    process.exit(1);
  }
}
if (!state.chat_messages.some((message) => message.direction === "outbound" && message.message_type === "agent")) {
  console.error("No worker-authored outbound chat messages found");
  process.exit(1);
}
console.log("Simulation verification passed");
