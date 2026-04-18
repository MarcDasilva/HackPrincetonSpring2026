import { JOB_STATUS, MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS } from "../shared/constants.js";

export async function buildForemanSnapshot(store) {
  const [worldObjects, workers, pendingJobs, activeJobs, inboundCommands, stockTargets] = await Promise.all([
    store.listWorldObjects(),
    store.listAgentStatus(),
    store.listJobs({ status: JOB_STATUS.pending }),
    store.listJobs({ status: JOB_STATUS.active }),
    store.listChatMessages({ direction: MESSAGE_DIRECTION.inbound, processing_status: MESSAGE_PROCESSING_STATUS.new }),
    store.listStockTargets(),
  ]);
  return { worldObjects, workers, pendingJobs, activeJobs, inboundCommands, stockTargets };
}

export async function buildTaskBrief(store, job, worker, triggerMessage = null) {
  const [worldObjects, memories] = await Promise.all([
    store.listWorldObjects(),
    store.getMemories(worker.agent_id, { limit: 5 }),
  ]);
  const relevantObjects = worldObjects.filter((object) => {
    const text = `${object.name} ${object.object_type} ${JSON.stringify(object.metadata)}`.toLowerCase();
    return !job.target || text.includes(String(job.target).toLowerCase()) || text.includes(String(job.kind).replace("_", " "));
  }).slice(0, 6);
  const inventory = worker.metadata?.inventory || [];

  return {
    objective: `Complete ${job.kind}${job.target ? ` for ${job.target}` : ""}${job.quantity ? ` x${job.quantity}` : ""}`,
    kind: job.kind,
    target: job.target,
    quantity: job.quantity,
    assigned_agent_id: worker.agent_id,
    source_chat: triggerMessage?.source_chat || job.payload?.source_chat || "group_chat",
    success_criteria: [
      "Update jobs_history with completion or blocker result.",
      "Write any durable observations to agent_memory.",
      "Only publish concise visible chat updates for meaningful state changes.",
    ],
    constraints: [
      "Truth comes from the supplied DB snapshot.",
      "Do not invent inventory, landmarks, or teammate actions.",
      "Do not read iMessage history for coordination.",
    ],
    relevant_context: {
      worker_state: worker,
      inventory,
      world_objects: relevantObjects,
      memories,
      stock: [],
      recent_human_override: triggerMessage,
    },
  };
}
