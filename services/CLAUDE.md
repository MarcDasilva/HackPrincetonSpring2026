# Service Layer Documentation: Data & Orchestration

## Overview

This directory contains the core infrastructure services for the SMS-to-Minecraft pipeline. These services abstract the complexity of Supabase (World State/Memory) and Upstash (Job Coordination).

## Core Services

### 1. `SessionManager.ts`

**Responsibility:** Maps physical device identifiers to virtual session metadata.

- **Key Method:** `getOrCreateSession(senderId: string)`
- **Data Map:** `sender_id` -> `{ thread_id, player_id, last_active }`
- **Persistence:** In-memory with Supabase fallback for recovery.

### 2. `JobQueueService.ts`

**Responsibility:** Manages atomic task assignment via Upstash Redis.

- **Pattern:** Distributed Locking (SETNX).
- **Workflow:** 1. Agent requests a job. 2. Service attempts to set a Redis key `job_lock:{id}` with a 60s TTL. 3. If success, agent proceeds. If failure, agent must request a different job.

### 3. `WorldStateService.ts`

**Responsibility:** The authoritative record of the Minecraft environment.

- **Tables:** `world_objects`
- **Realtime:** Implements Supabase Realtime listeners.
- **Critical Logic:** Any agent discovery (e.g., "Chest destroyed") must trigger an `update()` call here, which broadcasts the change to all other active agents via Postgres Changes.

### 4. `MemoryService.ts` (RAG Layer)

**Responsibility:** Vector-based retrieval of past agent experiences.

- **Logic:** Handles the generation of embeddings and the execution of the `match_memories` SQL RPC.
- **Contract:** Accepts a natural language query -> Returns top 3 relevant context snippets for prompt injection.

## Data Contracts & Schemas

### World Object Interface

```typescript
interface WorldObject {
  id: string;
  name: string;
  object_type: "chest" | "ore_vein" | "base" | "landmark";
  coords: { x: number; y: number; z: number };
  metadata: { status: "intact" | "destroyed" | "modified"; [key: string]: any };
  last_updated_by: string;
}
```
