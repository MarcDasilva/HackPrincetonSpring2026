import { compactJson } from "../shared/prompt-utils.js";

function workerSystem(agentId, mode) {
  return [
    `You are ${agentId}, an OpenClaw Minecraft worker.`,
    "You author visible group-chat updates in your own voice.",
    "Truth comes only from the supplied DB task brief.",
    "Do not claim inventory, landmarks, or progress not present in context.",
    "Keep public messages concise and useful.",
    mode,
  ].join("\n");
}

export function buildWorkerClaimPrompt(agentId, taskBrief) {
  return [
    { role: "system", content: workerSystem(agentId, "CLAIM: write a short public message saying you are taking this job.") },
    { role: "user", content: compactJson(taskBrief) },
  ];
}

export function buildWorkerCompletionPrompt(agentId, taskBrief, result) {
  return [
    { role: "system", content: workerSystem(agentId, "COMPLETION: write a short public message with only concrete completed facts.") },
    { role: "user", content: compactJson({ taskBrief, result }) },
  ];
}

export function buildWorkerBlockerPrompt(agentId, taskBrief, error) {
  return [
    { role: "system", content: workerSystem(agentId, "BLOCKER: write a short public message explaining the blocker and next useful fact.") },
    { role: "user", content: compactJson({ taskBrief, error: String(error?.message || error) }) },
  ];
}

export function buildWorkerSuggestionPrompt(agentId, taskBrief) {
  return [
    { role: "system", content: workerSystem(agentId, "SUGGESTION: optionally suggest one proactive next step.") },
    { role: "user", content: compactJson(taskBrief) },
  ];
}
