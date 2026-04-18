import { WORKER_ROLES } from "../shared/constants.js";

export async function ensureWorkerRegistered(store, workerId) {
  const role = WORKER_ROLES[workerId];
  if (!role) throw new Error(`Unknown worker ${workerId}`);
  const existing = await store.getAgentStatus?.(workerId);
  return store.upsertAgentStatus({
    agent_id: workerId,
    display_name: role.displayName,
    role: role.role,
    vm_name: role.vmName,
    status: existing?.status || "idle",
    current_job_id: existing?.current_job_id || null,
    current_task: existing?.current_task || null,
    health: existing?.health ?? null,
    food: existing?.food ?? null,
    dimension: existing?.dimension ?? null,
    x: existing?.x ?? null,
    y: existing?.y ?? null,
    z: existing?.z ?? null,
    metadata: { ...(existing?.metadata || {}), style: role.style, strengths: role.strengths },
  });
}

export function startHeartbeat(store, workerId, intervalMs, logger) {
  const beat = () => store.heartbeat(workerId).catch((error) => logger?.warn("Heartbeat failed", { workerId, error: error.message }));
  beat();
  const interval = setInterval(beat, intervalMs);
  return () => clearInterval(interval);
}
