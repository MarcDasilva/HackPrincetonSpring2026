import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIG
// ============================================================================

const MY_NUMBER = process.env.MY_NUMBER || "+19054629158";
const SIMULATION_MODE = String(process.env.SIMULATION_MODE || "false") === "true";

const VOYAGER_PATH =
  process.env.VOYAGER_PATH || "/path/to/voyager-repo";

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || "";

const AGENTS = ["1", "2", "3"];

const PHOTON_SERVER_URL = process.env.PHOTON_SERVER_URL || "";
const PHOTON_API_KEY = process.env.PHOTON_API_KEY || "";
const PHOTON_PROXY_URL =
  process.env.PHOTON_PROXY_URL || "https://imessage-swagger.photon.codes";

const DEFAULT_GROUP_NAME =
  process.env.DEFAULT_GROUP_NAME || "Minecraft Agents";

// ============================================================================
// HELPERS
// ============================================================================

function isGroupChat(space) {
  return space.id.includes(";+;") || space.id.includes("group");
}

function getAgentLabel(id) {
  return `Agent ${id}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPhotonBearerToken() {
  if (!PHOTON_SERVER_URL || !PHOTON_API_KEY) {
    return null;
  }
  return Buffer.from(`${PHOTON_SERVER_URL}|${PHOTON_API_KEY}`).toString("base64");
}

function sanitizePythonTripleQuotedString(input) {
  return String(input)
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '\\"\\"\\"');
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ============================================================================
// COMMAND PARSER
// ============================================================================

function parseCommand(text) {
  const trimmed = text.trim();

  // /creategroup +15551234567,+15557654321
  // /creategroup Team Alpha | +15551234567,+15557654321
  if (trimmed.startsWith("/creategroup")) {
    const rest = trimmed.replace("/creategroup", "").trim();

    let groupName = DEFAULT_GROUP_NAME;
    let rawParticipants = rest;

    if (rest.includes("|")) {
      const [namePart, participantPart] = rest.split("|");
      groupName = (namePart || "").trim() || DEFAULT_GROUP_NAME;
      rawParticipants = (participantPart || "").trim();
    }

    const participants = rawParticipants
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    return {
      type: "create_group",
      groupName,
      participants,
    };
  }

  // /sendgroup group:abc123 hello everyone
  if (trimmed.startsWith("/sendgroup")) {
    const rest = trimmed.replace("/sendgroup", "").trim();
    const firstSpace = rest.indexOf(" ");
    if (firstSpace > 0) {
      const groupId = rest.slice(0, firstSpace).trim();
      const message = rest.slice(firstSpace + 1).trim();
      if (groupId && message) {
        return {
          type: "send_group",
          groupId,
          message,
        };
      }
    }
  }

  // all agents chop wood
  let match = trimmed.match(/^(all agents|everyone)\s+(.+)$/i);
  if (match) {
    return { type: "task", targets: [...AGENTS], command: match[2].trim() };
  }

  // agent 1 chop wood
  match = trimmed.match(/^agent\s+([123])\s+(.+)$/i);
  if (match) {
    return { type: "task", targets: [match[1]], command: match[2].trim() };
  }

  // agents 1,2 chop wood
  // agents 1 2 3 chop wood
  match = trimmed.match(/^agents?\s+([123,\s]+)\s+(.+)$/i);
  if (match) {
    const ids = [
      ...new Set(
        match[1]
          .replace(/,/g, " ")
          .split(" ")
          .map((s) => s.trim())
          .filter(Boolean)
          .filter((id) => AGENTS.includes(id))
      ),
    ];

    if (ids.length > 0) {
      return { type: "task", targets: ids, command: match[2].trim() };
    }
  }

  return null;
}

// ============================================================================
// PHOTON ADVANCED GROUP CREATION / SEND
// ============================================================================

async function createGroupChat(participants, name = DEFAULT_GROUP_NAME) {
  const bearer = buildPhotonBearerToken();

  if (!bearer) {
    return {
      success: false,
      message:
        "Missing PHOTON_SERVER_URL or PHOTON_API_KEY. Group creation is not configured.",
    };
  }

  if (!participants || participants.length < 2) {
    return {
      success: false,
      message:
        "Use at least 2 participants. Example: /creategroup Team Alpha | +15551234567,+15557654321",
    };
  }

  const response = await fetch(`${PHOTON_PROXY_URL}/groups`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      participants,
      name,
    }),
  });

  const data = await safeJson(response);

  if (!response.ok) {
    return {
      success: false,
      message: `Failed to create group (${response.status}): ${
        data?.error || data?.message || JSON.stringify(data)
      }`,
      data,
    };
  }

  const groupId =
    data?.id || data?.groupId || data?.chatId || data?.guid || null;

  if (!groupId) {
    return {
      success: false,
      message: "Group created, but no group id was returned.",
      data,
    };
  }

  return {
    success: true,
    groupId,
    data,
    message: `✅ Created group "${name}" → ${groupId}`,
  };
}

async function sendMessageToGroup(groupId, text) {
  const bearer = buildPhotonBearerToken();

  if (!bearer) {
    return {
      success: false,
      message:
        "Missing PHOTON_SERVER_URL or PHOTON_API_KEY. Group sending is not configured.",
    };
  }

  const response = await fetch(`${PHOTON_PROXY_URL}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: groupId,
      text,
    }),
  });

  const data = await safeJson(response);

  if (!response.ok) {
    return {
      success: false,
      message: `Failed to send to group (${response.status}): ${
        data?.error || data?.message || JSON.stringify(data)
      }`,
      data,
    };
  }

  return {
    success: true,
    message: `✅ Sent kickoff message to ${groupId}`,
    data,
  };
}

// ============================================================================
// SIMULATOR
// ============================================================================

class Simulator {
  async run(agentId, command) {
    await sleep(600 + Math.random() * 1000);

    const responses = [
      "chopped wood",
      "built shelter",
      "mined iron",
      "found coal",
      "crafted tools",
      "gathered stone",
    ];

    return {
      success: true,
      result: responses[Math.floor(Math.random() * responses.length)],
    };
  }
}

// ============================================================================
// REAL VOYAGER EXECUTOR
// ============================================================================

class VoyagerExecutor {
  constructor(agentId) {
    this.agentId = agentId;
    this.isBusy = false;
    this.queue = [];
  }

  async run(command, send) {
    if (this.isBusy) {
      this.queue.push(command);
      await send(`🤖 ${getAgentLabel(this.agentId)} queued`);
      return;
    }

    this.isBusy = true;
    await send(`🤖 ${getAgentLabel(this.agentId)}: starting "${command}"`);

    try {
      if (SIMULATION_MODE) {
        const sim = new Simulator();
        const result = await sim.run(this.agentId, command);
        await send(`🤖 ${getAgentLabel(this.agentId)}: ${result.result}`);
        return;
      }

      const safeTask = sanitizePythonTripleQuotedString(command);
      const safeVoyagerPath = sanitizePythonTripleQuotedString(VOYAGER_PATH);
      const safeApiKey = sanitizePythonTripleQuotedString(OPENAI_API_KEY);

      const script = `
import os, sys
sys.path.insert(0, "${safeVoyagerPath}")

from voyager import Voyager

print("[VOYAGER] Agent ${this.agentId}: Initializing...")

voyager = Voyager(
    openai_api_key="${safeApiKey}",
    ckpt_dir="./ckpt/agent_${this.agentId}"
)

task = """${safeTask}"""

print("[VOYAGER] Agent ${this.agentId}: Task: " + task)
print("[VOYAGER] Agent ${this.agentId}: Decomposing task into sub-goals...")

sub_goals = voyager.decompose_task(task=task)
print("[VOYAGER] Agent ${this.agentId}: Sub-goals: " + str(sub_goals))
print("[VOYAGER] Agent ${this.agentId}: Executing in Minecraft...")

voyager.inference(sub_goals=sub_goals)

print("[VOYAGER] Agent ${this.agentId}: ✅ done")
`;

      const file = path.join(
        __dirname,
        `temp_agent_${this.agentId}_${Date.now()}.py`
      );
      fs.writeFileSync(file, script);

      await new Promise((resolve, reject) => {
        const proc = spawn("python3", [file], {
          cwd: VOYAGER_PATH,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            AGENT_ID: this.agentId,
          },
        });

        proc.stdout.on("data", async (data) => {
          const text = data.toString();
          const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

          for (const line of lines) {
            if (line.includes("[VOYAGER]")) {
              const status = line.replace("[VOYAGER]", "").trim();
              await send(`🤖 ${status}`);
            }
          }
        });

        proc.stderr.on("data", async (data) => {
          const text = data.toString().trim();
          if (text) {
            await send(`🤖 ${getAgentLabel(this.agentId)} error: ${text}`);
          }
        });

        proc.on("close", (code) => {
          try {
            fs.unlinkSync(file);
          } catch {}

          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Voyager exited with code ${code}`));
          }
        });
      });
    } catch (error) {
      await send(`🤖 ${getAgentLabel(this.agentId)}: ❌ ${error.message}`);
    } finally {
      this.isBusy = false;

      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.run(next, send).catch(console.error);
      }
    }
  }
}

// ============================================================================
// MULTI AGENT MANAGER
// ============================================================================

class Manager {
  constructor() {
    this.executors = {};
  }

  get(id) {
    if (!this.executors[id]) {
      this.executors[id] = new VoyagerExecutor(id);
    }
    return this.executors[id];
  }

  async run(targets, command, send) {
    await send(
      `Dispatching "${command}" to ${targets
        .map((t) => `Agent ${t}`)
        .join(", ")}`
    );

    await Promise.all(targets.map((id) => this.get(id).run(command, send)));
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const manager = new Manager();

  const app = await Spectrum({
    providers: [imessage.config({ local: true })],
  });

  console.log("Connected to iMessage via Spectrum");
  console.log("Listening for group messages...");

  const seen = new Set();

  for await (const [space, msg] of app.messages) {
    try {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);

      if (msg.sender.id === MY_NUMBER || msg.sender.id === "") continue;
      if (!isGroupChat(space)) continue;
      if (msg.content.type !== "text") continue;

      const text = (msg.content.text || "").trim();
      if (!text) continue;

      console.log("Message:", text);

      const send = async (messageText) => {
        console.log("SEND:", messageText);
        await space.send(messageText);
      };

      const parsed = parseCommand(text);

      if (!parsed) {
        await send(
          [
            "Use one of these:",
            "agent 1 chop wood",
            "agents 1,2 chop wood",
            "all agents chop wood",
            "/creategroup Team Alpha | +15551234567,+15557654321",
            "/sendgroup group:abc123 hello team",
          ].join("\n")
        );
        continue;
      }

      if (parsed.type === "create_group") {
        const result = await createGroupChat(
          parsed.participants,
          parsed.groupName
        );

        await send(result.message);

        if (result.success && result.groupId) {
          const kickoff = await sendMessageToGroup(
            result.groupId,
            `🤖 ${parsed.groupName} created and ready. Commands will run here once you message this group.`
          );

          if (!kickoff.success) {
            await send(kickoff.message);
          } else {
            await send(
              `✅ Kickoff sent to ${result.groupId}. Open that new group and start commanding agents there.`
            );
          }
        }

        continue;
      }

      if (parsed.type === "send_group") {
        const result = await sendMessageToGroup(parsed.groupId, parsed.message);
        await send(result.message);
        continue;
      }

      if (parsed.type === "task") {
        await manager.run(parsed.targets, parsed.command, send);
      }
    } catch (error) {
      console.error("Message handling error:", error);
      try {
        await space.send(`❌ Error: ${error.message}`);
      } catch {}
    }
  }
}

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});