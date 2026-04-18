import test from "node:test";
import assert from "node:assert/strict";
import { SimulationStore } from "../src/lib/simulation-store.js";
import { parseHumanCommand } from "../src/orchestrator/command-parser.js";
import { generateProactiveJobs } from "../src/orchestrator/job-generator.js";
import { chooseBestWorker } from "../src/orchestrator/job-scoring.js";
import { ForemanService } from "../src/orchestrator/foreman-service.js";
import { seedDemo } from "../src/simulation/seed-data.js";
import { createOpenClawClients } from "../src/lib/openclaw-client.js";
import { loadEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";

test("parseHumanCommand stores useful intent metadata", () => {
  const intent = parseHumanCommand({ id: "abc12345", content: "@miner focus iron" });
  assert.equal(intent.kind, "mine_ore");
  assert.equal(intent.target, "iron_ore");
  assert.equal(intent.preferred_worker_role, "miner");
});

test("generateProactiveJobs detects demo deficits", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await seedDemo(store);
  const jobs = generateProactiveJobs({
    worldObjects: await store.listWorldObjects(),
    stockTargets: await store.listStockTargets(),
    existingJobs: [],
  });
  assert.ok(jobs.some((job) => job.kind === "gather_food"));
  assert.ok(jobs.some((job) => job.kind === "expand_storage"));
});

test("job scoring sends iron to miner, storage to builder, food to forager", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await seedDemo(store);
  const workers = await store.listAgentStatus();
  const worldObjects = await store.listWorldObjects();
  assert.equal(chooseBestWorker({ kind: "mine_ore", target: "iron_ore" }, workers, worldObjects).worker.agent_id, "worker-miner");
  assert.equal(chooseBestWorker({ kind: "expand_storage", target: "base_storage" }, workers, worldObjects).worker.agent_id, "worker-builder");
  assert.equal(chooseBestWorker({ kind: "gather_food", target: "cooked_food" }, workers, worldObjects).worker.agent_id, "worker-forager");
});

test("foreman assigns jobs exclusively in seeded demo", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await seedDemo(store);
  const config = loadEnv({ OPENCLAW_FAKE_MODE: "true", VOYAGER_SIMULATION_MODE: "true" });
  const openclaw = createOpenClawClients(config);
  const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger: createLogger("test", "error") });
  await foreman.tick();
  const jobs = await store.listJobs();
  assert.ok(jobs.find((job) => job.kind === "mine_ore" && job.assigned_agent === "worker-miner"));
  assert.ok(jobs.find((job) => job.kind === "expand_storage" && job.assigned_agent === "worker-builder"));
  assert.ok(jobs.find((job) => job.kind === "gather_food" && job.assigned_agent === "worker-forager"));
});
