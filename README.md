# Voyager-1

Voyager-1 is a hybrid project that connects iMessage conversations to real Minecraft execution through Voyager bots.

This repository combines:
- A Photon/Spectrum iMessage orchestrator with approval-first planning (`index.js`)
- Local multi-agent Voyager execution in Python (`voyager/`)
- A Mineflayer HTTP bridge process for Minecraft control (`voyager/env/mineflayer/index.js`)
- Optional Supabase-backed shared memory and coordinate recall
- Optional Dedalus/OpenClaw deployment tooling for remote orchestration

## What Is Different From Upstream Voyager

This project specializes in additional runtime orchestration layers for:
- iMessage-first task intake
- Human approval before launch
- Multi-agent task assignment and dependency handling
- Process/run tracking with a local dashboard
- Supabase memory ingestion/retrieval and task enrichment

## Architecture

1. iMessage message arrives in Photon local/cloud mode.
2. `index.js` asks an OpenAI model to produce a JSON execution plan.
3. User approves the draft (`YES` or `/approve`).
4. Orchestrator spawns one or more Python Voyager workers.
5. Each worker drives its own Mineflayer bridge port and checkpoint directory.
6. Events are streamed to chat, persisted to `photon-progress/`, and shown in the dashboard.
7. If enabled, Supabase memory is read/written and location recalls are injected into tasks.

## Requirements

- Python `>=3.9`
- Node.js `>=18` (Node 20 recommended)
- Minecraft Java Edition with Fabric mods for Voyager workflows
- OpenAI API key
- macOS iMessage access (for local mode)

Optional:
- Photon cloud credentials for managed mode/group workflows
- Supabase credentials for shared memory
- Dedalus/OpenClaw tooling for remote deployment

## Installation

1. Install Node dependencies:

```bash
npm install
```

2. Install Python package and dependencies:

```bash
pip install -e .
```

3. Install Mineflayer bridge dependencies:

```bash
cd voyager/env/mineflayer
npm install
cd mineflayer-collectblock
npm install
npx tsc
cd ..
npm install
cd ../../..
```

4. Copy and edit environment file:

```bash
cp .env.example .env
```

## Minecraft Setup

Use the installation docs in this repo:
- [Minecraft instance setup](installation/minecraft_instance_install.md)
- [Fabric mods setup](installation/fabric_mods_install.md)

For LAN/offline flow, ensure your world is open to LAN and note the port.

## Configuration

Minimum for local orchestration:

```bash
OPENAI_API_KEY=...
VOYAGER_MC_PORT=25565
IMESSAGE_BOT_ID=+1...
```

Recommended baseline (see `.env.example` for full list):

```bash
OPENAI_MODEL=gpt-4.1-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
VOYAGER_SERVER_PORT=3000
VOYAGER_BOT_PREFIX=vgr
PYTHON_BIN=python3
VOYAGER_START_RETRIES=12
VOYAGER_START_THROTTLE_WAIT_SEC=20
VOYAGER_RESET_ENV_BETWEEN_SUBGOALS=0
VOYAGER_SKIP_DECOMPOSE_FOR_MULTI_AGENT=1
```

Current repo note: `index.js` presently pins `VOYAGER_PATH` to `/Users/marc/Voyager-1`. If your checkout path differs, update that constant in `index.js`.

Photon cloud mode (optional):

```bash
PHOTON_PROJECT_ID=...
PHOTON_PROJECT_SECRET=...
```

Supabase memory mode (optional):

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_SHARED_MEMORY_TABLE=agent_memory
VOYAGER_MEMORY_MCP_ENABLED=1
```

## Run

Primary entrypoint:

```bash
npm run photon
```

Equivalent:

```bash
npm start
```

At startup, the orchestrator prints:
- iMessage mode (`local` vs Photon cloud)
- Model settings
- Minecraft target host/port
- Tracking directory
- Dashboard URL (default `http://127.0.0.1:8787/dashboard`)

## iMessage Command Reference

Core control commands:
- `/status`
- `/status RUN_ID`
- `/approve`
- `/override ROLE|ASSIGNMENT_ID [TASK]`
- `/cancel`
- `/end`
- `/new TASK`
- `/help`

Memory commands:
- `/memory log <TEXT>`
- `/memory find <QUERY>`
- `/memory recent`

Natural-language memory logging is also supported (e.g. “log home chest at x=120 y=64 z=-240 in db”).

## Smoke Tests

Check local iMessage SDK connectivity:

```bash
npm test
```

Check Voyager import/init pipeline:

```bash
npm run test-pipeline
```

Check actual bot spawn/reset path:

```bash
npm run test-spawn
```

Check Supabase memory write/search/enrichment path:

```bash
npm run test-memory
```

## Running Voyager Directly (Without iMessage)

Interactive terminal mode:

```bash
python3 interactive.py --server-port 3000 --bot-username bot1 --ckpt-dir ckpt-bot1
```

Useful interactive commands:
- `/help`
- `/reset`
- `/status`
- `/quit`

Minimal Python usage:

```python
from voyager import Voyager

voyager = Voyager(
    mc_port=25565,
    server_port=3000,
    bot_username="bot",
    ckpt_dir="ckpt",
)

sub_goals = voyager.decompose_task("collect 10 logs")
voyager.inference(sub_goals=sub_goals)
voyager.close()
```

## Multi-Agent Notes

For concurrent agents in one world, each process needs unique values for:
- `server_port`
- `bot_username`
- `ckpt_dir`

The orchestrator handles this automatically per assignment by allocating ports and bot IDs.

## Logs, Tracking, and Artifacts

- Mineflayer bridge logs: `logs/mineflayer/`
- Run/proposal tracking JSON: `photon-progress/`
- Voyager checkpoints: `ckpt-*`
- Temporary generated task scripts: `temp_voyager_*.py`

## Repo Layout

- `index.js`: Primary Photon iMessage orchestrator
- `imessage-voyager-integration.js`: Legacy direct iMessage→Voyager bridge
- `voyager/`: Python Voyager package (agents, env bridge, prompts, utils)
- `voyager/env/mineflayer/`: Node Mineflayer HTTP server used by Python env
- `interactive.py`: Direct terminal interface for Voyager
- `scripts/`: Smoke tests, Supabase memory test, Photon stdin bridge, Dedalus ops
- `scripts/dedalus/`: Provision/bootstrap/start/stop scripts for remote machines
- `.vm-openclaw/`: OpenClaw-oriented orchestration runtime (experimental)
- `server-snapshots/`: Snapshot assets for OpenClaw gateway/server state
- `installation/`: Minecraft + Fabric setup docs
- `skill_library/`: Example learned skill libraries

## Ops and Remote Deployment

Dedalus helper scripts are provided for remote machine lifecycle and stack startup:
- `scripts/dedalus/provision-machine.sh`
- `scripts/dedalus/bootstrap-machine.sh`
- `scripts/dedalus/start-stack.sh`
- `scripts/dedalus/stop-stack.sh`
- `scripts/dedalus/status.sh`

There is also a Photon handoff bridge script:
- `scripts/photon-stdin-bridge.mjs`

## Troubleshooting

- Mineflayer startup/reconnect issues: inspect `logs/mineflayer/*.log`
- General Voyager FAQ: [FAQ.md](FAQ.md)
- Fabric/world setup issues: `installation/` docs above

## License and Acknowledgements

- This repository is licensed under [MIT](LICENSE).
- Voyager core is based on the original MineDojo Voyager project and adapted here for iMessage/Photon orchestration workflows.

Original Citation

```bibtex
@article{wang2023voyager,
  title   = {Voyager: An Open-Ended Embodied Agent with Large Language Models},
  author  = {Guanzhi Wang and Yuqi Xie and Yunfan Jiang and Ajay Mandlekar and Chaowei Xiao and Yuke Zhu and Linxi Fan and Anima Anandkumar},
  year    = {2023},
  journal = {arXiv preprint arXiv: Arxiv-2305.16291}
}
```
