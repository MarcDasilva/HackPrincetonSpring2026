# Architecture

The iMessage group is a human-facing UI, not an internal bus. Photon writes inbound messages to `chat_messages`; the foreman and workers coordinate through Supabase tables and Realtime.

Flow:

1. Human sends iMessage.
2. Photon bridge inserts inbound `chat_messages`.
3. Foreman reads command, world state, worker heartbeats, jobs, and memories.
4. Foreman creates `jobs_history` rows and claims each job atomically for one worker.
5. Worker runtime receives its own active job, asks worker OpenClaw for public text, and executes through Voyager.
6. Worker writes `job_events`, `agent_memory`, completion state, and outbound `chat_messages`.
7. Photon sends pending outbound messages to the group.

Workers receive narrow `task_brief` objects instead of full global state.
