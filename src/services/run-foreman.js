import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { createOpenClawClients } from "../lib/openclaw-client.js";
import { createStateStore, ensureDefaultStockTargets } from "../lib/supabase.js";
import { ForemanService } from "../orchestrator/foreman-service.js";

const config = loadEnv();
const logger = createLogger("foreman", config.logLevel);
const store = await createStateStore(config);
await ensureDefaultStockTargets(store);
const openclaw = createOpenClawClients(config);
const foreman = new ForemanService({
  store,
  openclaw: openclaw.foreman,
  logger,
  allowedDmSenders: config.photon.dmAllowedSenders,
});

logger.info("Starting OpenClaw foreman", { simulation: !config.supabase.url });
foreman.start();

process.on("SIGINT", () => {
  foreman.stop();
  process.exit(0);
});
