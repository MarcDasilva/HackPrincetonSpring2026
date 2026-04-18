import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20260418_multi_agent_orchestration.sql", "utf8");

test("migration defines persistent-memory canonical tables", () => {
  for (const table of ["world_objects", "agent_status", "chat_messages", "jobs_history", "agent_memory"]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
});

test("migration defines realtime tables and atomic RPCs", () => {
  for (const table of ["chat_messages", "jobs_history", "agent_status", "job_events", "world_objects"]) {
    assert.match(sql, new RegExp(`alter publication supabase_realtime add table public\\.${table}`));
  }
  assert.match(sql, /claim_job_history/);
  assert.match(sql, /release_job_history/);
});

test("migration includes required indexes", () => {
  for (const index of [
    "world_objects_type_updated_idx",
    "agent_status_last_heartbeat_idx",
    "jobs_history_status_priority_started_idx",
    "chat_messages_direction_processing_created_idx",
  ]) {
    assert.match(sql, new RegExp(index));
  }
});
