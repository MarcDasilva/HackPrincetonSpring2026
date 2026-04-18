# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

iMessage-controlled Minecraft AI agents. Users send natural-language commands via iMessage, which get routed to specialized Minecraft agents (miner, builder, planner, explorer, farmer) that execute tasks in-game using the Voyager framework.

Two operating modes:
- **Local iMessage mode** — reads the Mac Messages database directly, DMs only
- **Photon cloud mode** — uses `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` for managed iMessage with group chat support

## Commands

```bash
# Install
npm install
pip install -e .

# Run the main iMessage→Voyager bot
npm run voyager          # node imessage-voyager-integration.js

# Run the OpenClaw-based orchestrator bot
npm start                # node index.js

# Test local iMessage connection
npm test                 # node test.js

# Interactive terminal mode (Python, no iMessage)
python3 interactive.py --mc-port <LAN_PORT>

# Multi-bot on same LAN world (each needs unique port/username/ckpt)
python3 interactive.py --server-port 3000 --bot-username bot1 --ckpt-dir ckpt-bot1
python3 interactive.py --server-port 3001 --bot-username bot2 --ckpt-dir ckpt-bot2

# Compile mineflayer TypeScript (required once)
cd voyager/env/mineflayer/mineflayer-collectblock && npx tsc
```

## Architecture

### JS Layer (iMessage bridge)

- **`index.js`** — Spectrum/iMessage bot that uses OpenAI to parse user intent into a structured JSON handoff payload, then pipes it to an external `OPENCLAW_COMMAND` process via stdin.
- **`imessage-voyager-integration.js`** — Full iMessage→Minecraft bridge. Routes messages to typed agents (planner/builder/miner/explorer/farmer) by keyword matching. Supports simulation mode (`SIMULATION_MODE=true`) or real Voyager execution. Per-group agent registry managed via `/addagent`, `/removeagent`, `/agents` chat commands.

Both JS entry points use `spectrum-ts` with the `imessage` provider. Photon credentials are auto-detected from env vars.

### Python Layer (Voyager)

`voyager/` is a fork of MineDojo/Voyager — an LLM-powered Minecraft agent with four cooperating sub-agents:

- **ActionAgent** (`voyager/agents/action.py`) — iterative code generation; writes and executes Mineflayer JS
- **CurriculumAgent** (`voyager/agents/curriculum.py`) — automatic task curriculum / goal selection
- **CriticAgent** (`voyager/agents/critic.py`) — self-verification of task completion
- **SkillManager** (`voyager/agents/skill.py`) — vector-indexed library of learned executable skills (ChromaDB)

`voyager/env/` bridges Python↔Mineflayer via a Node.js subprocess (`bridge.py`). The Mineflayer bot code lives in `voyager/env/mineflayer/`.

### LLM Configuration

`voyager/llms.py` resolves API keys and models with a fallback chain: `OPENAI_API_KEY` → `K2_API_KEY` → `CEREBRAS_API_KEY`. Base URL similarly falls through `OPENAI_BASE_URL` → `K2_BASE_URL` → `CEREBRAS_BASE_URL`. Default chat model is `gpt-4o-2024-08-06`.

## Key Environment Variables

See `.env.example` for the full list. The critical ones:
- `OPENAI_API_KEY` — required for both JS and Python layers
- `VOYAGER_MC_PORT` — Minecraft LAN port
- `VOYAGER_SERVER_PORT` — local Mineflayer bridge port (default 3000)
- `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` — enables cloud iMessage + group chats
- `OPENCLAW_COMMAND` — external orchestrator binary path (used by `index.js`)

## Requirements

- Python ≥ 3.9, Node.js ≥ 16.13.0
- Minecraft with Fabric mods (version `fabric-loader-0.14.18-1.19`)
- macOS for local iMessage mode (reads `~/Library/Messages/chat.db`)
