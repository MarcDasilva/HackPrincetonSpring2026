# Supabase Model

Canonical tables come from the `persistent-memory` branch:

- `world_objects`
- `agent_status`
- `chat_messages`
- `jobs_history`
- `agent_memory`

Extensions:

- `stock_targets` for proactive work
- `job_events` for internal structured coordination
- `claim_job_history()` and `release_job_history()` for exclusive ownership

Realtime should be enabled for `chat_messages`, `jobs_history`, `agent_status`, `job_events`, and `world_objects`.
