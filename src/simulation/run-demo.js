import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { createOpenClawClients } from "../lib/openclaw-client.js";
import { createStateStore, ensureDefaultStockTargets } from "../lib/supabase.js";
import { ForemanService } from "../orchestrator/foreman-service.js";
import { WORKER_IDS } from "../shared/constants.js";
import { VoyagerAdapter } from "../worker/voyager-adapter.js";
import { WorkerRuntime } from "../worker/worker-runtime.js";
import { seedDemo } from "./seed-data.js";

const config = loadEnv({
  ...process.env,
  PHOTON_MODE: "simulation",
  OPENCLAW_FAKE_MODE: "true",
  VOYAGER_SIMULATION_MODE: "true",
});
const logger = createLogger("simulation", config.logLevel);
const store = await createStateStore(config, { forceSimulation: true });
await seedDemo(store);
await ensureDefaultStockTargets(store);

const openclaw = createOpenClawClients(config);
const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger: logger.child("foreman") });
const workers = WORKER_IDS.map((workerId) => new WorkerRuntime({
  workerId,
  store,
  openclaw: openclaw.workers[workerId],
  voyager: new VoyagerAdapter({ simulationMode: true, logger: logger.child(workerId) }),
  heartbeatIntervalMs: 1000,
  logger: logger.child(workerId),
}));

for (const worker of workers) await worker.start();
await foreman.tick();
await new Promise((resolve) => setTimeout(resolve, 2500));
await foreman.tick();
await new Promise((resolve) => setTimeout(resolve, 1500));

for (const worker of workers) worker.stop();
const state = await store.getState();
console.log(JSON.stringify({
  jobs: state.jobs_history.map((job) => ({ job_id: job.job_id, kind: job.kind, assigned_agent: job.assigned_agent, status: job.status })),
  outbound_messages: state.chat_messages.filter((message) => message.direction === "outbound").map((message) => ({ sender: message.sender, content: message.content })),
}, null, 2));
