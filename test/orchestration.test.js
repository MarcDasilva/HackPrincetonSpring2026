import test from "node:test";
import assert from "node:assert/strict";
import { SimulationStore } from "../src/lib/simulation-store.js";
import { parseHumanCommand } from "../src/orchestrator/command-parser.js";
import { createJobsFromIntent, generateProactiveJobs } from "../src/orchestrator/job-generator.js";
import { chooseBestWorker } from "../src/orchestrator/job-scoring.js";
import { ForemanService } from "../src/orchestrator/foreman-service.js";
import { seedDemo } from "../src/simulation/seed-data.js";
import { createOpenClawClients } from "../src/lib/openclaw-client.js";
import { loadEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";
import { AGENT_IDS, JOB_STATUS, MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, MESSAGE_TYPE, OUTBOUND_STATUS } from "../src/shared/constants.js";
import { WorkerRuntime } from "../src/worker/worker-runtime.js";

test("parseHumanCommand stores useful intent metadata", () => {
  const intent = parseHumanCommand({ id: "abc12345", content: "@miner focus iron" });
  assert.equal(intent.kind, "mine_ore");
  assert.equal(intent.target, "iron_ore");
  assert.equal(intent.preferred_worker_role, "miner");
});

test("parseHumanCommand treats wood requests as gather wood even when phrased as farm", () => {
  const intent = parseHumanCommand({ id: "abc12345", content: "Farm for some wood" });
  assert.equal(intent.kind, "gather_wood");
  assert.equal(intent.target, "oak_log");
});

test("parseHumanCommand treats inventory questions as read-only checks", () => {
  const intent = parseHumanCommand({ id: "abc12345", content: "how much wood collected so far" });
  assert.equal(intent.kind, "inventory_check");
  assert.equal(intent.target, "oak_log");
});

test("human command jobs preserve the exact request as the objective", () => {
  const intent = parseHumanCommand({
    id: "abc12345",
    source_chat: "iMessage;-;+15551234567",
    sender: "+15551234567",
    content: "find a village and mark the path back with torches",
  });
  intent.job_id = "cmd-freeform";
  const [job] = createJobsFromIntent(intent);
  assert.equal(job.payload.objective, "find a village and mark the path back with torches");
  assert.equal(job.payload.source_chat, "iMessage;-;+15551234567");
});

test("group-chat setup base expands into coordinated worker jobs", () => {
  const intent = parseHumanCommand({ id: "abc12345", source_chat: "group", sender: "user", content: "setup a new base" });
  intent.job_id = "cmd-build-base";
  const jobs = createJobsFromIntent(intent);
  assert.deepEqual(jobs.map((job) => job.kind), ["gather_wood", "gather_stone", "build_base", "build_base"]);
  assert.deepEqual(jobs.map((job) => job.payload.preferred_worker_id), [
    AGENT_IDS.forager,
    AGENT_IDS.miner,
    AGENT_IDS.builder,
    AGENT_IDS.builder,
  ]);
  assert.equal(jobs[0].payload.skill_id, "setup_new_base_v1");
  assert.equal(jobs[2].payload.plan_step, "prepare_base_site");
  assert.deepEqual(jobs[2].payload.depends_on, []);
  assert.deepEqual(jobs[3].payload.depends_on, ["forage_base_materials", "mine_base_materials", "prepare_base_site"]);
  assert.ok(jobs[3].payload.required_materials.find((item) => item.item_name === "oak_log"));
});

test("explicit all-agents group chat fans one request to every worker", () => {
  const intent = parseHumanCommand({ id: "abc12345", source_chat: "group", sender: "user", content: "all agents need wood" });
  intent.job_id = "cmd-gather-wood";
  const jobs = createJobsFromIntent(intent);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((job) => job.payload.preferred_worker_id), [
    AGENT_IDS.miner,
    AGENT_IDS.builder,
    AGENT_IDS.forager,
  ]);
});

test("foreman publishes a group-chat dispatch and shares command memory", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  for (const [agentId, role] of [
    [AGENT_IDS.miner, "miner"],
    [AGENT_IDS.builder, "builder"],
    [AGENT_IDS.forager, "forager"],
  ]) {
    await store.upsertAgentStatus({
      agent_id: agentId,
      display_name: role,
      role,
      vm_name: agentId,
      status: "idle",
      current_task: null,
      metadata: { inventory: [], empty_inventory_slots: 10 },
    });
  }
  await store.insertChatMessage({
    sender: "user",
    message_type: MESSAGE_TYPE.user,
    content: "setup base",
    source_chat: "group",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
  });

  const config = loadEnv({ OPENCLAW_FAKE_MODE: "true", VOYAGER_SIMULATION_MODE: "true" });
  const openclaw = createOpenClawClients(config);
  const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger: createLogger("test", "error") });
  await foreman.tick();

  const jobs = await store.listJobs();
  assert.ok(jobs.find((job) => job.kind === "gather_wood" && job.assigned_agent === AGENT_IDS.forager));
  assert.ok(jobs.find((job) => job.kind === "gather_stone" && job.assigned_agent === AGENT_IDS.miner));
  assert.ok(jobs.find((job) => job.kind === "build_base" && job.target === "base_site" && job.assigned_agent === AGENT_IDS.builder));
  assert.ok(jobs.find((job) => job.kind === "build_base" && job.target === "starter_base" && job.status === "pending"));
  const messages = await store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound });
  assert.ok(messages.some((message) => message.sender === AGENT_IDS.foreman && message.content.includes("Coordinating 4 tasks")));
  assert.ok(messages.some((message) => message.sender === AGENT_IDS.foreman && message.source_chat === "group"));
  for (const workerId of [AGENT_IDS.miner, AGENT_IDS.builder, AGENT_IDS.forager]) {
    const memories = await store.getMemories(workerId, { memory_type: "observation" });
    assert.equal(memories[0].content.text, "setup base");
    assert.equal(memories[0].content.channel, "group");
  }
});

test("foreman keeps DM dispatch quiet for routine jobs", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.forager,
    display_name: "Forager",
    role: "forager",
    vm_name: "worker-forager",
    status: "idle",
    current_task: null,
    metadata: { inventory: [], empty_inventory_slots: 10 },
  });
  await store.insertChatMessage({
    sender: "+15551234567",
    message_type: MESSAGE_TYPE.user,
    content: "Farm for some wood",
    source_chat: "any;-;+15551234567",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: { channel: "dm" },
  });

  const config = loadEnv({ OPENCLAW_FAKE_MODE: "true", VOYAGER_SIMULATION_MODE: "true" });
  const openclaw = createOpenClawClients(config);
  const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger: createLogger("test", "error") });
  await foreman.tick();

  const jobs = await store.listJobs();
  assert.ok(jobs.find((job) => job.kind === "gather_wood" && job.target === "oak_log"));
  const messages = await store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound });
  assert.equal(messages.length, 0);
});

test("foreman ignores untrusted DM rows that did not come through the Photon bridge", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.miner,
    display_name: "Miner",
    role: "miner",
    vm_name: "worker-miner",
    status: "idle",
    current_task: null,
    metadata: {},
  });
  await store.insertChatMessage({
    sender: "+15550000000",
    message_type: MESSAGE_TYPE.user,
    content: "@miner gather dirt",
    source_chat: "any;-;+15550000000",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: {},
  });

  const config = loadEnv({ OPENCLAW_FAKE_MODE: "true", VOYAGER_SIMULATION_MODE: "true" });
  const openclaw = createOpenClawClients(config);
  const foreman = new ForemanService({
    store,
    openclaw: openclaw.foreman,
    logger: createLogger("test", "error"),
    allowedDmSenders: ["+15551234567"],
  });
  await foreman.tick();

  assert.equal((await store.listJobs()).length, 0);
  const inbound = (await store.listChatMessages({ direction: MESSAGE_DIRECTION.inbound }))[0];
  assert.equal(inbound.processing_status, MESSAGE_PROCESSING_STATUS.ignored);
  assert.equal(inbound.metadata.ignored_reason, "untrusted_dm_source");
});

test("foreman ignores link-only texts instead of dispatching jobs", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.insertChatMessage({
    sender: "+15551234567",
    message_type: MESSAGE_TYPE.user,
    content: "https://www.curseforge.com/minecraft/mc-mods/automobility",
    source_chat: "any;-;+15551234567",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: { channel: "dm" },
  });

  const config = loadEnv({ OPENCLAW_FAKE_MODE: "true", VOYAGER_SIMULATION_MODE: "true" });
  const openclaw = createOpenClawClients(config);
  const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger: createLogger("test", "error") });
  await foreman.tick();

  assert.equal((await store.listJobs()).length, 0);
  const inbound = (await store.listChatMessages({ direction: MESSAGE_DIRECTION.inbound }))[0];
  assert.equal(inbound.processing_status, MESSAGE_PROCESSING_STATUS.ignored);
  assert.equal(inbound.metadata.ignored_reason, "link_without_instruction");
});

test("foreman answers read-only inventory checks instead of creating jobs", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertWorldObject({
    object_id: "base-storage",
    object_type: "storage",
    name: "Base storage",
    position: { x: 0, y: 64, z: 0 },
    metadata: { stock: { oak_log: 12 } },
  });
  await store.insertChatMessage({
    sender: "+15551234567",
    message_type: MESSAGE_TYPE.user,
    content: "how much wood collected so far",
    source_chat: "any;-;+15551234567",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: { channel: "dm" },
  });

  const config = loadEnv({ OPENCLAW_FAKE_MODE: "true", VOYAGER_SIMULATION_MODE: "true" });
  const openclaw = createOpenClawClients(config);
  const foreman = new ForemanService({ store, openclaw: openclaw.foreman, logger: createLogger("test", "error") });
  await foreman.tick();

  assert.equal((await store.listJobs()).length, 0);
  const messages = await store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound });
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /12 oak log/);
});

test("worker publishes a death status when execution reports death", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.miner,
    display_name: "Miner",
    role: "miner",
    vm_name: "worker-miner",
    status: "busy",
    current_task: "mine_ore iron_ore",
    metadata: {},
  });
  const job = await store.createJob({
    job_id: "death-test",
    kind: "mine_ore",
    target: "iron_ore",
    quantity: 1,
    assigned_agent: AGENT_IDS.miner,
    status: "active",
    task_brief: {
      objective: "Mine iron",
      kind: "mine_ore",
      target: "iron_ore",
      quantity: 1,
      assigned_agent_id: AGENT_IDS.miner,
      source_chat: "group",
      relevant_context: {},
    },
  });
  const runtime = new WorkerRuntime({
    workerId: AGENT_IDS.miner,
    store,
    openclaw: { getWorkerMessage: async () => ({ public_text: "blocked" }) },
    voyager: { executeTask: async () => ({ success: false, summary: "I died to a zombie" }) },
    logger: createLogger("test", "error"),
  });

  await runtime.executeJob(job);

  const status = await store.getAgentStatus(AGENT_IDS.miner);
  assert.equal(status.status, "dead");
  const messages = await store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound });
  assert.ok(messages.some((message) => message.content.includes("I died while working on mine_ore iron_ore")));
});

test("worker suppresses claim and simulated completion chat", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.forager,
    display_name: "Forager",
    role: "forager",
    vm_name: "worker-forager",
    status: "busy",
    current_task: "gather_wood oak_log",
    metadata: {},
  });
  const job = await store.createJob({
    job_id: "quiet-test",
    kind: "gather_wood",
    target: "oak_log",
    quantity: 8,
    source: "human",
    assigned_agent: AGENT_IDS.forager,
    status: "active",
    task_brief: {
      objective: "Farm for some wood",
      kind: "gather_wood",
      target: "oak_log",
      quantity: 8,
      assigned_agent_id: AGENT_IDS.forager,
      source_chat: "any;-;+15551234567",
      relevant_context: {},
    },
  });
  const runtime = new WorkerRuntime({
    workerId: AGENT_IDS.forager,
    store,
    openclaw: { getWorkerMessage: async () => ({ public_text: "should not be used" }) },
    voyager: {
      executeTask: async () => ({
        success: true,
        mode: "simulation",
        summary: "simulated",
        inventory_delta: { oak_log: 8 },
      }),
    },
    logger: createLogger("test", "error"),
  });

  await runtime.executeJob(job);

  assert.equal((await store.getJob(job.id)).status, "completed");
  const messages = await store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound });
  assert.equal(messages.length, 0);
});

test("worker blocks jobs when Minecraft runtime is not connected", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.miner,
    display_name: "Miner",
    role: "miner",
    vm_name: "worker-miner",
    status: "idle",
    current_task: null,
    metadata: {},
  });
  const job = await store.createJob({
    job_id: "not-connected-test",
    kind: "mine_ore",
    target: "iron_ore",
    source: "human",
    assigned_agent: AGENT_IDS.miner,
    status: JOB_STATUS.active,
    task_brief: {
      objective: "Mine iron",
      kind: "mine_ore",
      target: "iron_ore",
      assigned_agent_id: AGENT_IDS.miner,
      source_chat: "any;-;+15551234567",
      relevant_context: {},
    },
  });
  let executed = false;
  const runtime = new WorkerRuntime({
    workerId: AGENT_IDS.miner,
    store,
    openclaw: { getWorkerMessage: async () => ({ public_text: "should not be used" }) },
    voyager: {
      getMinecraftReadiness: () => ({
        ready: false,
        mode: "simulation",
        reasons: ["VOYAGER_SIMULATION_MODE is enabled", "VOYAGER_MC_HOST is not set"],
        minecraft: { host: null, port: null },
      }),
      executeTask: async () => {
        executed = true;
        return { success: true };
      },
    },
    logger: createLogger("test", "error"),
  });

  await runtime.executeJob(job);

  assert.equal(executed, false);
  const updated = await store.getJob(job.id);
  assert.equal(updated.status, JOB_STATUS.blocked);
  assert.equal(updated.result.intended_status, "not_connected");
  const status = await store.getAgentStatus(AGENT_IDS.miner);
  assert.equal(status.status, "offline");
  assert.equal(status.current_task, "not connected to Minecraft");
  const messages = await store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound });
  assert.equal(messages.length, 0);
});

test("builder waits for base setup material jobs before building", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  await store.upsertAgentStatus({
    agent_id: AGENT_IDS.builder,
    display_name: "Builder",
    role: "builder",
    vm_name: "worker-builder",
    status: "busy",
    current_task: "build_base starter_base",
    metadata: {},
  });
  const plan_id = "setup_new_base_v1:test";
  const foragerJob = await store.createJob({
    job_id: "base-forager",
    kind: "gather_wood",
    target: "oak_log",
    status: "pending",
    payload: { plan_id, plan_step: "forage_base_materials" },
  });
  const minerJob = await store.createJob({
    job_id: "base-miner",
    kind: "gather_stone",
    target: "cobblestone",
    status: "pending",
    payload: { plan_id, plan_step: "mine_base_materials" },
  });
  const builderJob = await store.createJob({
    job_id: "base-builder",
    kind: "build_base",
    target: "starter_base",
    assigned_agent: AGENT_IDS.builder,
    status: "active",
    payload: {
      plan_id,
      plan_step: "build_starter_base",
      depends_on: ["forage_base_materials", "mine_base_materials"],
    },
    task_brief: {
      objective: "Build a starter base",
      kind: "build_base",
      target: "starter_base",
      assigned_agent_id: AGENT_IDS.builder,
      source_chat: "group",
      coordination: {
        plan_id,
        depends_on: ["forage_base_materials", "mine_base_materials"],
      },
      relevant_context: {},
    },
  });
  let executed = false;
  const runtime = new WorkerRuntime({
    workerId: AGENT_IDS.builder,
    store,
    openclaw: { getWorkerMessage: async () => ({ public_text: "done" }) },
    voyager: {
      executeTask: async () => {
        executed = true;
        return { success: true, summary: "base built" };
      },
    },
    logger: createLogger("test", "error"),
  });

  await runtime.executeJob(builderJob);
  assert.equal(executed, false);
  const waitingStatus = await store.getAgentStatus(AGENT_IDS.builder);
  assert.equal(waitingStatus.status, "busy");
  assert.match(waitingStatus.current_task, /waiting for forage base materials, mine base materials/);

  await store.updateJob(foragerJob.id, { status: "completed" });
  await store.updateJob(minerJob.id, { status: "completed" });
  await runtime.executeJob(await store.getJob(builderJob.id));

  assert.equal(executed, true);
  assert.equal((await store.getJob(builderJob.id)).status, "completed");
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
