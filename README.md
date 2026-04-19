# Multi-Agent Minecraft Coordination via Shared World State and RAG-Driven Directives

A system where multiple specialized AI agents coordinate Minecraft tasks through a shared group chat, backed by a real-time PostgreSQL world state and a retrieval-augmented directive layer that learns user preferences over time.

## How It Works

The user sends natural language commands to a group chat containing multiple agents, each with a specialized role. An orchestration layer parses intent, creates jobs, and dispatches them to the appropriate agent. Agents don't operate in isolation. They share a single Supabase database that acts as a real-time world model, and they communicate with each other through the same chat interface the user sees.

When an agent receives a task, it goes through the following cycle:

1. Queries a RAG pipeline for user-defined directives ("what does the user want me to do after mining?")
2. Queries the world state for live data ("where is the nearest iron ore?")
3. Pulls its own persistent memory for prior observations ("I found a large vein at these coordinates last time")
4. Executes the task using Voyager's skill library and action agent
5. Writes results back to the world state, stores new observations in memory, and reports to the group chat

Every action an agent takes feeds back into the shared state, so the other two agents are always working with current information.

## Architecture

```
User
  |
  v
Group Chat (chat_messages table, realtime)
  |
  v
Orchestrator
  |
  +---> Agent 1: Miner ---+
  +---> Agent 2: Crafter --+--> Supabase (world state, jobs, memory)
  +---> Agent 3: Scout ----+         |
                                     +--> pgvector RAG (agent directives)
                                     +--> Redis (distributed job locking)
                                     |
                                     v
                                  Voyager (Minecraft execution)
```

### Supabase (Shared Brain)

Six PostgreSQL tables with realtime subscriptions and vector search:

**world_objects** stores every meaningful entity in the game world: ore veins, chests, bases. Each record has coordinates, typed metadata, and an optional embedding for semantic queries. When the scout discovers a new iron deposit or the miner depletes one, the table updates and all agents see the change immediately via Postgres NOTIFY.

**agent_status** tracks each agent's heartbeat, current activity, and state. The orchestrator uses this to know who is available before dispatching work.

**chat_messages** holds the full conversation history. Agents subscribe to INSERT events so they see user commands and teammate messages in real time.

**jobs_history** manages the full task lifecycle. Jobs move from pending to active to completed or failed. Each record carries a payload (the original instruction) and a result (what actually happened), both as JSONB.

**agent_memory** gives each agent persistent knowledge across sessions. Observations, plans, and reflections are stored with agent-scoped indexes. Before acting, an agent pulls its recent memories and injects them into its LLM prompt so it retains context about what it has seen and done.

**md_documents** stores embedded markdown files containing user preferences and agent directives. These are queried via cosine similarity through a stored procedure, not read directly.

### RAG Directive Layer

Agent behavior is governed by a single markdown file (`agents.md`) that contains role assignments, workflow rules, and user preferences. This file is embedded using OpenAI's text-embedding-3-small and stored in Supabase with an IVFFlat index for fast similarity search.

The key distinction: the MD file tells agents what to do and when. It does not contain coordinates, skill implementations, or execution logic. Locations come from `world_objects`. Execution comes from Voyager. The directive layer fills the gap between what Voyager knows how to do and what the user actually wants done.

When the user decides that pickaxes should always be rebuilt after mining, that rule goes into `agents.md`, gets re-embedded, and every agent picks it up on its next task. The system improves iteratively without code changes.

### Redis (Job Locking)

Upstash Redis handles distributed locking via SETNX with a five-minute TTL. When a job enters the queue, agents race to claim it. The first one to acquire the lock wins. This prevents duplicate work when multiple agents are active simultaneously.

### Voyager (Minecraft Execution)

Voyager provides the entire Minecraft execution layer. Its action agent generates and runs Mineflayer JavaScript code for mining, crafting, building, and navigation. Its skill manager maintains a growing library of learned skills stored as JS functions with vector-searchable descriptions. Its curriculum agent handles task decomposition and its critic agent self-verifies task completion.

We do not duplicate any of this. Our system wraps Voyager with coordination, memory, and user preference layers that it lacks on its own.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Database and Realtime | Supabase (PostgreSQL, pgvector, Realtime) |
| Vector Search | pgvector with IVFFlat indexing |
| Job Locking | Upstash Redis |
| Embeddings | OpenAI text-embedding-3-small |
| Minecraft Execution | Voyager (MineDojo) |
| Agent Orchestration | OpenClaw |
| Language | TypeScript |

## Project Structure

```
src/
  services/
    WorldStateService.ts      # CRUD + realtime for all Supabase tables
    AgentMemoryService.ts     # Per-agent persistent knowledge
    JobQueueService.ts        # Redis distributed locking
    MDRAGService.ts           # Semantic search over directive documents
  types/
    schemas.ts                # TypeScript interfaces for all tables
docs/
  agents.md                   # User preferences and agent directives
scripts/
  load-md-documents.ts        # Embeds and uploads MD files to Supabase
```

## Running It

Set environment variables:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-service-key
UPSTASH_REDIS_URL=https://...
UPSTASH_REDIS_TOKEN=...
OPENAI_API_KEY=...
```

Load the directive file into Supabase:

```bash
npx tsx scripts/load-md-documents.ts
```

The database schema is deployed via Supabase's SQL Editor. All table definitions, indexes, stored procedures, and realtime publications are included in the project's SQL files.

## What Makes This Different

Most Minecraft bots are single agents following scripted routines. This system runs multiple agents that share a live world model, coordinate through natural language, and adapt to user preferences without retraining or redeployment. The separation between Voyager's execution capabilities and our directive/memory/coordination layer means the agents get better at following user intent while Voyager independently gets better at executing tasks. Both improve over time, and they improve independently.

## Citation

@article{wang2023voyager,
  title   = {Voyager: An Open-Ended Embodied Agent with Large Language Models},
  author  = {Guanzhi Wang and Yuqi Xie and Yunfan Jiang and Ajay Mandlekar and Chaowei Xiao and Yuke Zhu and Linxi Fan and Anima Anandkumar},
  year    = {2023},
  journal = {arXiv preprint arXiv: Arxiv-2305.16291}
}
