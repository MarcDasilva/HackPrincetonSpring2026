1# Architecture Specification: SMS-to-Minecraft Agent Pipeline

## Overview

This document defines the middleware orchestration layer bridging a physical SMS gateway (Photon Spectrum) to a virtual game environment (Minecraft), utilizing an LLM agent (Dedalus Labs) for task decomposition and reasoning.

1 real player will communicate with multiple agents to get them to perform tasks that they define

The objective is to build a highly robust, strictly typed Node.js/TypeScript pipeline that handles asynchronous game states, error propagation, and multi-user session tracking.

## System Architecture (The Pipeline)

### Phase 1: Ingestion (Photon Gateway -> Orchestrator)

The Orchestrator receives incoming SMS data. It must immediately acknowledge receipt to prevent gateway timeouts and map the incoming phone number to an active Minecraft player ID and Dedalus thread ID.

### Phase 2: Context Aggregation

### Phase 3: Agent Orchestration (Dedalus API)

The Orchestrator packages the user's raw text instruction with the aggregated Minecraft game state and sends it to the Dedalus Agent. The agent is responsible for intent classification and decomposing the request into an array of strict Model Context Protocol (MCP) tool calls.

### Phase 4: Game Execution

The Orchestrator parses the MCP tool calls returned by Dedalus and proxies them to the Minecraft Game Engine API for sequential execution.

### Phase 5: Asynchronous User Feedback

Game actions take time. The Orchestrator must maintain an open channel to the Photon outbound API, sending status updates ("Gathering resources...", "Task complete") to the user's device as the game engine resolves tasks.

### ARCHITECTURE UPDATE: VOYAGER INTEGRATION

We are no longer directly interacting with a raw Minecraft API, nor are we managing game state in this Orchestrator layer. The Minecraft environment is managed entirely by an autonomous agent framework called Voyager.

**The New Pipeline:**

1. Photon Ingestion: We receive SMS text.
2. Dedalus Handoff: We immediately POST the raw text and user session ID to the Dedalus Supervisor Agent. We DO NOT need to aggregate Minecraft state first.
3. Asynchronous Wait: Dedalus will independently trigger the Voyager instance to execute the task.
4. Response: Dedalus returns the final conversational string to our Orchestrator, which we text back to the user.

**Updated Context Payload (Orchestrator -> Dedalus):**
{
"thread_id": "thr_898a9b",
"user_instruction": "build a wooden shelter"
}
// Note: game_state has been removed. Voyager handles state natively.

---

## JSON Data Contracts (Strict Schemas)

### 1. Ingestion Payload (Photon -> Orchestrator)

```json

{
  "thread_id": "thr_898a9b",
  "player_id": "player_01",
  "user_instruction": "build a wooden shelter"
}

{
  "status": "success",
  "user_message": "Got it! I've dispatched the agent to build your wooden shelter. I'll text you when the construction is finished."
}

```
