import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { PhotonBridge } from "../lib/photon-bridge.js";
import { createStateStore } from "../lib/supabase.js";

const config = loadEnv();
const logger = createLogger("photon-bridge", config.logLevel);
const store = await createStateStore(config);
const bridge = new PhotonBridge({ config, store, logger });

await bridge.start();
