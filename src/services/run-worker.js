import { loadEnv, assertServiceEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { createOpenClawClients } from "../lib/openclaw-client.js";
import { createStateStore } from "../lib/supabase.js";
import { VoyagerAdapter } from "../worker/voyager-adapter.js";
import { WorkerRuntime } from "../worker/worker-runtime.js";

const config = loadEnv();
assertServiceEnv(config, "worker");
const logger = createLogger(config.workerId, config.logLevel);
const store = await createStateStore(config);
const openclaw = createOpenClawClients(config);
const voyager = new VoyagerAdapter({
  voyagerPath: config.voyager.path,
  pythonPath: config.voyager.pythonPath,
  ckptDir: config.voyager.ckptDir,
  minecraft: {
    host: config.voyager.mcHost,
    port: config.voyager.mcPort,
    serverPort: config.voyager.serverPort,
    botUsername: config.voyager.botUsername,
  },
  simulationMode: config.voyager.simulationMode,
  workerId: config.workerId,
  logger,
});
const runtime = new WorkerRuntime({
  workerId: config.workerId,
  store,
  openclaw: openclaw.workers[config.workerId],
  voyager,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  logger,
});

logger.info("Starting OpenClaw worker", { workerId: config.workerId, voyagerSimulation: config.voyager.simulationMode });
await runtime.start();

process.on("SIGINT", () => {
  runtime.stop();
  process.exit(0);
});
