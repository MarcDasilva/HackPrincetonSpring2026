import { loadEnv } from "../config/env.js";
import { createStateStore } from "../lib/supabase.js";
import { seedDemo } from "./seed-data.js";

const config = loadEnv({ ...process.env, PHOTON_MODE: process.env.PHOTON_MODE || "simulation" });
const store = await createStateStore(config, { forceSimulation: true });
await seedDemo(store);
console.log(`Seeded demo state at ${config.simulationDbPath}`);
