import { JOB_STATUS, WORKER_IDS, WORLD_OBJECT_TYPES } from "../shared/constants.js";
import { JOB_KINDS } from "../shared/job-types.js";

export function createJobFromIntent(intent) {
  return {
    job_id: intent.job_id,
    kind: intent.kind,
    target: intent.target,
    quantity: intent.quantity,
    priority: intent.priority ?? (intent.shortcut ? 80 : 60),
    status: JOB_STATUS.pending,
    source: "human",
    payload: {
      raw_text: intent.raw_text,
      request_text: intent.request_text || intent.raw_text,
      objective: intent.objective || intent.request_text || intent.raw_text || null,
      source_message_id: intent.source_message_id,
      source_chat: intent.source_chat,
      sender: intent.sender || null,
      preferred_worker_id: intent.preferred_worker_id || null,
      preferred_worker_role: intent.preferred_worker_role,
      target_worker_ids: intent.target_worker_ids || [],
      skill_id: intent.skill_id || null,
      plan_id: intent.plan_id || null,
      plan_summary: intent.plan_summary || null,
      plan_index: intent.plan_index ?? null,
      plan_step: intent.plan_step || null,
      depends_on: intent.depends_on || [],
      required_materials: intent.required_materials || [],
      outputs: intent.outputs || [],
      coordination_notes: intent.coordination_notes || [],
      voyager_sub_goals: intent.voyager_sub_goals || [],
    },
  };
}

function createSingleJobSpecs(intent) {
  const explicitTargets = intent.target_worker_ids || [];
  if (explicitTargets.length > 1) {
    return explicitTargets.map((workerId) => ({
      ...intent,
      preferred_worker_id: workerId,
      target_worker_ids: [workerId],
      priority: 85,
    }));
  }
  return [intent];
}

export function createJobsFromIntent(intent) {
  const explicitTargets = intent.target_worker_ids || [];
  const shouldUsePlan = intent.plan?.jobs?.length && (explicitTargets.length === 0 || explicitTargets.length === WORKER_IDS.length);
  const specs = shouldUsePlan
    ? intent.plan.jobs.map((job, index) => ({
        ...intent,
        ...job,
        target_worker_ids: [job.preferred_worker_id].filter(Boolean),
        skill_id: intent.plan.skill_id || null,
        plan_id: intent.plan.plan_id || null,
        plan_summary: intent.plan.summary,
        plan_index: index,
        priority: 90 - index,
      }))
    : createSingleJobSpecs(intent);

  return specs.map((spec, index) => createJobFromIntent({
    ...spec,
    job_id: specs.length > 1 ? `${intent.job_id}-${index + 1}` : spec.job_id || intent.job_id,
  }));
}

function stockCount(worldObjects, itemName) {
  let total = 0;
  for (const object of worldObjects) {
    const inventory = object.metadata?.items || object.metadata?.inventory || [];
    if (Array.isArray(inventory)) {
      for (const item of inventory) {
        if (typeof item === "string" && item === itemName) total += 1;
        if (item?.item_name === itemName || item?.name === itemName) total += Number(item.count || 1);
      }
    }
    if (object.metadata?.stock?.[itemName]) total += Number(object.metadata.stock[itemName]);
  }
  return total;
}

function storageSlots(worldObjects) {
  return worldObjects
    .filter((object) => [WORLD_OBJECT_TYPES.chest, WORLD_OBJECT_TYPES.storage].includes(object.object_type))
    .reduce((sum, object) => sum + Number(object.metadata?.empty_slots ?? 0), 0);
}

export function generateProactiveJobs({ worldObjects, stockTargets, existingJobs }) {
  const openKeys = new Set(existingJobs
    .filter((job) => [JOB_STATUS.pending, JOB_STATUS.active, JOB_STATUS.blocked].includes(job.status))
    .map((job) => `${job.kind}:${job.target || ""}`));
  const jobs = [];
  const targetByName = Object.fromEntries(stockTargets.map((target) => [target.item_name, target]));

  const add = (job) => {
    const key = `${job.kind}:${job.target || ""}`;
    if (openKeys.has(key)) return;
    openKeys.add(key);
    jobs.push({
      job_id: `auto-${job.kind}-${job.target || "baseline"}`,
      status: JOB_STATUS.pending,
      source: "proactive",
      quantity: null,
      priority: 30,
      payload: {},
      ...job,
    });
  };

  const foodTarget = targetByName.cooked_food;
  if (foodTarget && stockCount(worldObjects, "cooked_food") < foodTarget.min_count) {
    add({ kind: JOB_KINDS.gatherFood, target: "cooked_food", quantity: foodTarget.target_count, priority: 55, payload: { reason: "food below target" } });
  }

  const pickaxeTarget = targetByName.pickaxe;
  if (pickaxeTarget && stockCount(worldObjects, "pickaxe") < pickaxeTarget.min_count) {
    add({ kind: JOB_KINDS.craftTools, target: "pickaxe", quantity: pickaxeTarget.target_count, priority: 45, payload: { reason: "no spare pickaxe at base" } });
  }

  const torchTarget = targetByName.torch;
  if (torchTarget && stockCount(worldObjects, "torch") < torchTarget.min_count) {
    add({ kind: JOB_KINDS.craftTorches, target: "torch", quantity: torchTarget.target_count, priority: 40, payload: { reason: "torches below threshold" } });
  }

  const storageTarget = targetByName.empty_storage_slots;
  if (storageTarget && storageSlots(worldObjects) < storageTarget.min_count) {
    add({ kind: JOB_KINDS.expandStorage, target: "base_storage", quantity: storageTarget.target_count, priority: 50, payload: { reason: "storage nearly full" } });
  }

  if (stockCount(worldObjects, "raw_iron") > 0 && stockCount(worldObjects, "coal") > 0) {
    add({ kind: JOB_KINDS.smeltOre, target: "raw_iron", quantity: null, priority: 35, payload: { reason: "ore and fuel available" } });
  }

  return jobs;
}
