# OpenClaw Minecraft Orchestrator

This branch turns the hackathon prototype into a real multi-agent orchestration system:

1. A macOS Photon bridge watches one iMessage group chat.
2. Photon writes inbound human commands to Supabase `chat_messages`.
3. A control-plane OpenClaw foreman reads Supabase state, creates jobs, and assigns workers.
4. Three Dedalus worker VMs run worker OpenClaw runtimes over Voyager execution.
5. Workers author visible group-chat updates, but Supabase/Postgres is the internal coordination bus.

## Canonical Database Model

This branch uses the `persistent-memory` model as the source of truth:

- `world_objects`: bases, chests, farms, ore veins, landmarks, and resource locations.
- `agent_status`: worker identity, VM, role, heartbeat, current task, health, food, and location.
- `chat_messages`: inbound iMessage commands and outbound visible agent-authored updates.
- `jobs_history`: pending, active, blocked, failed, and completed work.
- `agent_memory`: observations, plans, reflections, and notes for narrow prompt context.

Small helper tables extend that model:

- `stock_targets` drives proactive work.
- `job_events` records structured internal coordination.

Job ownership is claimed through Postgres RPCs, not Redis and not iMessage.

## Run Locally

Install dependencies:

```bash
npm install
```

Run the deterministic local demo:

```bash
npm run simulation
npm run simulation:verify
```

The demo seeds:

- a base camp
- an iron vein near the miner
- nearly full storage near the builder
- a farm near the forager
- low food, torches, pickaxes, and storage capacity

Expected assignment:

- miner -> iron
- builder -> storage
- forager -> food

## Services

```bash
npm run photon          # macOS only, iMessage bridge
npm run foreman         # control-plane Dedalus VM
npm run worker:miner    # worker Dedalus VM
npm run worker:builder
npm run worker:forager
```

Photon must run on a Mac host with iMessage access. Dedalus Linux VMs run the foreman and worker runtimes, not the iMessage bridge.

## Environment

Copy `.env.example` to `.env` and fill in real values for Supabase, Photon, OpenClaw, Voyager, and Dedalus. Fake OpenClaw and fake Voyager modes are available for local simulation.

## Supabase

Apply `supabase/migrations/20260418_multi_agent_orchestration.sql`.

Realtime is configured for:

- `chat_messages`
- `jobs_history`
- `agent_status`
- `job_events`
- `world_objects`

## Dedalus

Bootstrap scripts install under `/home/machine`, write `/home/machine/start-gateway.sh`, and use `setsid` instead of systemd:

```bash
node scripts/deploy-control-vm.js
node scripts/deploy-worker-vm.js --worker=miner
node scripts/deploy-worker-vm.js --worker=builder
node scripts/deploy-worker-vm.js --worker=forager
```

Store VM-local secrets in `/home/machine/openclaw.env`.

## Status

Implemented:

- canonical persistent-memory schema
- Supabase and simulation state stores
- OpenClaw HTTP/fake client
- Photon bridge adapter
- foreman job generation and assignment
- worker heartbeat, status publishing, and Voyager adapter
- seeded simulation and tests

Blocked by real infrastructure:

- real Photon group id and macOS permissions
- deployed OpenClaw gateways
- Supabase project credentials
- Voyager/Minecraft runtime on worker VMs
