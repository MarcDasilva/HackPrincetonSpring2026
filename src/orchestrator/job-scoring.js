import { JOB_CAPABILITIES } from "../shared/job-types.js";
import { getWorkerRole } from "../shared/schemas.js";

function distance(agent, object) {
  if (!object?.coords || agent.x == null || agent.y == null || agent.z == null) return 50;
  return Math.sqrt((agent.x - object.coords.x) ** 2 + (agent.y - object.coords.y) ** 2 + (agent.z - object.coords.z) ** 2);
}

function hasItem(agent, itemName) {
  const inventory = agent.metadata?.inventory || [];
  return inventory.some((item) => {
    if (typeof item === "string") return item.includes(itemName);
    return String(item.item_name || item.name || "").includes(itemName) && Number(item.count || 1) > 0;
  });
}

export function scoreWorkerForJob(worker, job, worldObjects = []) {
  const role = worker.role || getWorkerRole(worker.agent_id);
  const capableRoles = JOB_CAPABILITIES[job.kind] || [];
  const capabilityFit = capableRoles.includes(role) ? 50 : 5;
  const relatedObjects = worldObjects.filter((object) => {
    const text = `${object.name} ${object.object_type} ${JSON.stringify(object.metadata)}`.toLowerCase();
    return !job.target || text.includes(String(job.target).replace("_", " ")) || text.includes(String(job.target));
  });
  const nearest = relatedObjects.length ? Math.min(...relatedObjects.map((object) => distance(worker, object))) : 50;
  const proximityFit = Math.max(0, 20 - Math.min(nearest, 100) / 5);
  const equipmentFit =
    (job.kind === "mine_ore" && hasItem(worker, "pickaxe") ? 15 : 0) +
    (job.kind === "expand_storage" && (hasItem(worker, "plank") || hasItem(worker, "wood")) ? 10 : 0) +
    (job.kind === "gather_food" && (worker.metadata?.empty_inventory_slots ?? 0) > 4 ? 10 : 0);
  const continuityBonus = worker.current_job_id === job.id || worker.current_task?.includes(job.kind) ? 8 : 0;
  const currentLoadPenalty = worker.status === "busy" ? 35 : 0;
  const riskPenalty = Number(worker.health ?? 20) < 8 || Number(worker.food ?? 20) < 6 ? 15 : 0;
  const score = capabilityFit + proximityFit + equipmentFit + continuityBonus - currentLoadPenalty - riskPenalty;
  return { score, factors: { capabilityFit, proximityFit, equipmentFit, continuityBonus, currentLoadPenalty, riskPenalty } };
}

export function chooseBestWorker(job, workers, worldObjects = []) {
  const candidates = workers
    .filter((worker) => worker.status !== "offline")
    .map((worker) => ({ worker, ...scoreWorkerForJob(worker, job, worldObjects) }))
    .sort((a, b) => b.score - a.score || a.worker.agent_id.localeCompare(b.worker.agent_id));
  return candidates[0] || null;
}
