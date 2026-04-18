import { compactJson } from "../shared/prompt-utils.js";

export function buildForemanPlanningPrompt(snapshot) {
  return [
    {
      role: "system",
      content: [
        "You are the OpenClaw foreman for Minecraft workers.",
        "Supabase tables are the source of truth.",
        "Return only JSON with assignments, priority_updates, and optional plan_message.",
        "Create narrow assignments; never send full global state to a worker.",
      ].join("\n"),
    },
    {
      role: "user",
      content: compactJson({
        workers: snapshot.workers,
        pending_jobs: snapshot.pendingJobs,
        active_jobs: snapshot.activeJobs,
        world_objects: snapshot.worldObjects.slice(0, 20),
        new_commands: snapshot.inboundCommands,
      }),
    },
  ];
}

export function buildNarrowTaskExecutionBriefPrompt(taskBrief) {
  return [
    {
      role: "system",
      content: "Convert this task brief into a short execution checklist. Use only supplied facts.",
    },
    { role: "user", content: compactJson(taskBrief) },
  ];
}
