import { parseJsonObject } from "../shared/prompt-utils.js";
import { foremanPlanSchema, workerMessageSchema } from "../shared/schemas.js";
import { withRetry } from "./logger.js";

export class OpenClawClient {
  constructor({ url, token, fakeMode = false, role = "worker" }) {
    this.url = url;
    this.token = token;
    this.fakeMode = fakeMode || !url;
    this.role = role;
  }

  async chat(messages, options = {}) {
    if (this.fakeMode) return this.fakeChat(messages, options);
    const endpoint = `${this.url.replace(/\/$/, "")}/v1/chat/completions`;
    return withRetry(async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          model: options.model || "openclaw",
          temperature: options.temperature ?? 0.2,
          messages,
        }),
      });
      if (!response.ok) throw new Error(`OpenClaw ${response.status}: ${await response.text()}`);
      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    });
  }

  fakeChat(messages, options = {}) {
    const joined = messages.map((message) => message.content).join("\n");
    if (options.responseType === "foreman_plan") {
      return JSON.stringify({ assignments: [], priority_updates: [], plan_message: null });
    }
    const agentId = options.agentId || "worker";
    const task = options.taskBrief?.objective || "the assigned task";
    if (joined.includes("BLOCKER")) return JSON.stringify({ public_text: `${agentId}: Blocked on ${task}. I logged the issue and I am waiting for a safer route.` });
    if (joined.includes("COMPLETION")) return JSON.stringify({ public_text: `${agentId}: Finished ${task}. I updated shared state with the result.` });
    if (joined.includes("CLAIM")) return JSON.stringify({ public_text: `${agentId}: Claiming ${task}. I will report back when it changes state.` });
    return JSON.stringify({ public_text: `${agentId}: Working on ${task}.` });
  }

  async getForemanPlan(messages) {
    const text = await this.chat(messages, { responseType: "foreman_plan" });
    return foremanPlanSchema.parse(parseJsonObject(text, { assignments: [], priority_updates: [], plan_message: null }));
  }

  async getWorkerMessage(messages, options = {}) {
    const text = await this.chat(messages, { ...options, responseType: "worker_message" });
    return workerMessageSchema.parse(parseJsonObject(text, { public_text: text || "Working on it." }));
  }
}

export function createOpenClawClients(config) {
  return {
    foreman: new OpenClawClient({ ...config.openclaw.foreman, fakeMode: config.openclaw.fakeMode, role: "foreman" }),
    workers: Object.fromEntries(Object.entries(config.openclaw.workers).map(([agentId, target]) => [
      agentId,
      new OpenClawClient({ ...target, fakeMode: config.openclaw.fakeMode, role: agentId }),
    ])),
  };
}
