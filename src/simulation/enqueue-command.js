import { loadEnv } from "../config/env.js";
import { ingestInboundMessage } from "../lib/photon-bridge.js";
import { createStateStore } from "../lib/supabase.js";

const text = process.argv.slice(2).join(" ") || "mine 10 iron ore";
const config = loadEnv({ ...process.env, PHOTON_MODE: "simulation" });
const store = await createStateStore(config, { forceSimulation: true });
await ingestInboundMessage(store, { sourceChat: "simulation-group", sender: "user", text });
console.log(`Enqueued: ${text}`);
