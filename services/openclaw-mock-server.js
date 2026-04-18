/**
 * OpenClaw Mock Server
 *
 * Standalone HTTP server that implements the same API contract the real
 * OpenClaw VM will expose. Use it to develop and test the iMessage→VM
 * connection without a live VM.
 *
 * Start:  node services/openclaw-mock-server.js
 * Port:   OPENCLAW_MOCK_PORT env var (default 3001)
 *
 * Endpoints:
 *   POST /api/task         — create a task   → { taskId, status }
 *   GET  /api/task/:taskId — poll status      → { taskId, status, progress?, result?, error? }
 *   GET  /api/health       — health check     → { status, agents, uptime, tasksProcessed }
 */

import http from "http";
import { randomUUID } from "crypto";

const PORT = parseInt(process.env.OPENCLAW_MOCK_PORT || "3001", 10);

// ── In-memory task store ────────────────────────────────────────────────────

const tasks = new Map();

// ── Canned results per agent type ───────────────────────────────────────────

const MOCK_RESULTS = {
  miner: [
    "Mined 16 iron ore from depth Y=12",
    "Collected 64 cobblestone blocks",
    "Found diamond at (45, 11, -89)!",
    "Gathered 32 oak wood logs",
  ],
  builder: [
    "Built structure successfully! Used 24 wood planks",
    "Crafted 3 tools: pickaxe, axe, sword",
    "Constructed shelter at base coordinates",
    "Placed crafting table and furnace",
  ],
  planner: [
    "Analyzed terrain - found optimal location at (100, 64, -200)",
    "Strategy complete: Need 64 wood, 32 cobblestone, 16 iron",
    "Planned route: Mine → Crafting Table → Forest",
  ],
  explorer: [
    "Explored 500 blocks north - found desert biome",
    "Scouted location: stronghold at (234, 45, -678)",
    "Discovered village 300 blocks east",
  ],
  farmer: [
    "Planted 16 wheat seeds, ready in ~5 min",
    "Harvested 32 carrots and 16 potatoes",
    "Built animal pen with 4 cows and 3 sheep",
  ],
};

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Request body parser ─────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── Route matching ──────────────────────────────────────────────────────────

function matchRoute(method, url) {
  if (method === "POST" && url === "/api/task") return "createTask";
  if (method === "GET" && url.startsWith("/api/task/")) return "getTask";
  if (method === "GET" && url === "/api/health") return "health";
  return null;
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  const route = matchRoute(req.method, req.url);

  try {
    // ── POST /api/task ────────────────────────────────────────────────────
    if (route === "createTask") {
      const body = await parseBody(req);
      const taskId = randomUUID();

      const task = {
        taskId,
        agent: body.agent || "unknown",
        command: body.command || "",
        status: "queued",
        progress: null,
        result: null,
        error: null,
      };

      tasks.set(taskId, task);

      // Simulate lifecycle:  queued → running (1 s) → completed/failed (3-5 s)
      setTimeout(() => {
        if (!tasks.has(taskId)) return;
        task.status = "running";
        task.progress = `Processing: "${task.command}"`;
      }, 1000);

      const finishDelay = 3000 + Math.random() * 2000;
      setTimeout(() => {
        if (!tasks.has(taskId)) return;
        if (Math.random() > 0.1) {
          task.status = "completed";
          const pool = MOCK_RESULTS[task.agent] || [`Completed task for ${task.agent}`];
          task.result = randomFrom(pool);
        } else {
          task.status = "failed";
          task.error = "Simulated failure: bot got stuck";
        }
      }, finishDelay);

      console.log(`📋 Created task ${taskId} [${task.agent}]: "${task.command}"`);
      res.writeHead(201);
      res.end(JSON.stringify({ taskId, status: "queued" }));
      return;
    }

    // ── GET /api/task/:taskId ─────────────────────────────────────────────
    if (route === "getTask") {
      const taskId = req.url.replace("/api/task/", "");
      const task = tasks.get(taskId);

      if (!task) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Task not found" }));
        return;
      }

      res.end(
        JSON.stringify({
          taskId: task.taskId,
          status: task.status,
          progress: task.progress,
          result: task.result,
          error: task.error,
        }),
      );
      return;
    }

    // ── GET /api/health ───────────────────────────────────────────────────
    if (route === "health") {
      res.end(
        JSON.stringify({
          status: "ok",
          agents: Object.keys(MOCK_RESULTS),
          uptime: process.uptime(),
          tasksProcessed: tasks.size,
        }),
      );
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🧪 OpenClaw Mock Server running on http://localhost:${PORT}`);
  console.log(`\n   POST /api/task          Create a task`);
  console.log(`   GET  /api/task/:taskId  Poll task status`);
  console.log(`   GET  /api/health        Health check`);
  console.log(`\n   This implements the exact API your partner's VM needs to expose.`);
  console.log(`   Give them this file as a reference implementation.\n`);
});
