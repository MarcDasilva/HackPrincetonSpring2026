# Implementation Status

Done:

- persistent-memory schema migration
- modular Node ESM structure
- Supabase and simulation stores
- Photon bridge adapter
- OpenClaw client with fake mode
- foreman orchestration, scoring, proactive jobs, and narrow briefs
- worker runtime, heartbeat, status publisher, Voyager adapter
- seeded simulation
- unit and migration tests

Mocked:

- OpenClaw responses in `OPENCLAW_FAKE_MODE`
- Voyager execution in `VOYAGER_SIMULATION_MODE`
- local file-backed Supabase substitute for simulation

Blocked by real infra:

- actual Supabase project
- actual Photon/iMessage group
- deployed OpenClaw gateways
- Voyager and Minecraft runtime on worker VMs
- Dedalus machine ids and credentials

Next:

- apply migration to Supabase
- deploy foreman and workers to Dedalus
- run Photon bridge on macOS
- turn off fake OpenClaw/Voyager modes one VM at a time
