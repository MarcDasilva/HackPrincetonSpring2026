import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { createOpenClawClients } from "../lib/openclaw-client.js";
import { createStateStore, ensureDefaultStockTargets } from "../lib/supabase.js";
import { ForemanService } from "../orchestrator/foreman-service.js";
import { AGENT_IDS } from "../shared/constants.js";

const config = loadEnv();
const logger = createLogger("foreman", config.logLevel);
const store = await createStateStore(config);
await store.upsertAgentStatus({
  agent_id: AGENT_IDS.foreman,
  display_name: "Foreman",
  role: "foreman",
  vm_name: "foreman",
  status: "idle",
  current_job_id: null,
  current_task: null,
  metadata: {
    style: "coordinated, systems-focused",
    strengths: ["triage", "planning", "assignment"],
  },
});
await ensureDefaultStockTargets(store);
const openclaw = createOpenClawClients(config);
const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger });

logger.info("Starting OpenClaw foreman", { simulation: !config.supabase.url });
foreman.start();

process.on("SIGINT", () => {
  foreman.stop();
  process.exit(0);
});
