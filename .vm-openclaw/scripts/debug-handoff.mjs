import { loadEnv } from "../src/config/env.js";
import { createStateStore } from "../src/lib/supabase.js";

const minutes = Number(process.argv[2] || "20");
const cutoff = Date.now() - minutes * 60 * 1000;
const store = await createStateStore(loadEnv(process.env));

const messages = await store.listChatMessages({ direction: "inbound" });
const recent = messages
  .filter((msg) => new Date(msg.created_at).getTime() >= cutoff)
  .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

const jobs = await store.listJobs();

for (const message of recent) {
  const parsed = message.metadata?.parsed_intent || null;
  const linkedJobs = jobs.filter((job) => job.payload?.source_message_id === message.id);
  const summary = {
    message_id: message.id,
    at: message.created_at,
    source_chat: message.source_chat,
    sender: message.sender,
    text: message.content || message.raw_text || "",
    processing_status: message.processing_status,
    parsed_kind: parsed?.kind || null,
    parsed_job_id: parsed?.job_id || null,
    linked_jobs: linkedJobs.map((job) => ({
      job_id: job.job_id,
      kind: job.kind,
      target: job.target,
      status: job.status,
      assigned_agent: job.assigned_agent,
      started_at: job.started_at,
      completed_at: job.completed_at,
    })),
  };
  console.log(JSON.stringify(summary));
}
