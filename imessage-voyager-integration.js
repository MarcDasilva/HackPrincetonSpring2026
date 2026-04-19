/**
 * iMessage → Voyager Minecraft Integration
 *
 * Bridges iMessage group chat with Python Voyager bot for REAL Minecraft control
 *
 * Updated targeting behavior:
 * - "agent 1 chop wood"
 * - "agents 1,2 chop wood"
 * - "all agents chop wood"
 *
 * Core repo behavior preserved:
 * - Spectrum/iMessage integration
 * - Group-chat-only processing
 * - Simulation mode vs real Voyager mode
 * - Python subprocess execution for real mode
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

const MY_NUMBER = "+19054629158";
const SIMULATION_MODE = false; // Set to false when Voyager is fully setup
const VOYAGER_PATH =
  process.env.VOYAGER_PATH || "/Users/williamzhang/Hackathon!!/voyager-repo";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "YOUR_API_KEY_HERE";

const AGENT_IDS = ["1", "2", "3"];

// ============================================================================
// HELPERS
// ============================================================================

function getAgentLabel(agentId) {
  return `Agent ${agentId}`;
}

function isGroupChat(space) {
  return space.id.includes(";+;") || space.id.includes("group");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapePythonTripleQuotedString(input) {
  return String(input)
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '\\"\\"\\"');
}

function parseTargetedCommand(message) {
  const text = message.trim();

  // all agents chop wood
  // everyone chop wood
  const allMatch = text.match(/^(all\s+agents|everyone)\s+(.+)$/i);
  if (allMatch) {
    return {
      targets: [...AGENT_IDS],
      command: allMatch[2].trim(),
    };
  }

  // agent 1 chop wood
  const singleMatch = text.match(/^agent\s+([123])\s+(.+)$/i);
  if (singleMatch) {
    return {
      targets: [singleMatch[1]],
      command: singleMatch[2].trim(),
    };
  }

  // agents 1,2 chop wood
  // agents 1 2 3 chop wood
  const multiMatch = text.match(/^agents?\s+([123,\s]+)\s+(.+)$/i);
  if (multiMatch) {
    const nums = multiMatch[1]
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((n) => AGENT_IDS.includes(n));

    const uniqueNums = [...new Set(nums)];

    if (uniqueNums.length > 0) {
      return {
        targets: uniqueNums,
        command: multiMatch[2].trim(),
      };
    }
  }

  return null;
}

// ============================================================================
// VOYAGER SIMULATOR (for testing without Minecraft)
// ============================================================================

class VoyagerSimulator {
  constructor() {
    this.taskCount = 0;
    this.inventory = {
      wood: 0,
      cobblestone: 0,
      iron_ore: 0,
      coal: 0,
      diamond: 0,
    };
  }

  async executeTask(agentId, command) {
    this.taskCount++;

    console.log(`\n[Voyager Sim] Task #${this.taskCount}`);
    console.log(`Agent: ${getAgentLabel(agentId)}`);
    console.log(`Command: "${command}"`);

    await sleep(500 + Math.random() * 1000);

    const responses = [
      "Gathered 32 oak wood logs",
      "Collected 64 cobblestone blocks",
      "Mined 16 iron ore from depth Y=12",
      "Found diamond at (45, 11, -89)!",
      "Crafted basic tools successfully",
      "Built a small shelter near spawn",
    ];

    const response = responses[Math.floor(Math.random() * responses.length)];
    this.updateInventory(response);

    const success = Math.random() > 0.1;

    if (success) {
      console.log(`✅ Success: ${response}`);
      return { success: true, result: response };
    } else {
      console.log(`❌ Failed: Task error`);
      return { success: false, error: "Ran out of resources or got stuck" };
    }
  }

  updateInventory(response) {
    const normalized = response.toLowerCase();

    if (normalized.includes("wood")) this.inventory.wood += 32;
    if (normalized.includes("cobblestone")) this.inventory.cobblestone += 64;
    if (normalized.includes("iron ore")) this.inventory.iron_ore += 16;
    if (normalized.includes("coal")) this.inventory.coal += 16;
    if (normalized.includes("diamond")) this.inventory.diamond += 1;
  }

  getInventoryStatus() {
    return Object.entries(this.inventory)
      .filter(([, count]) => count > 0)
      .map(([item, count]) => `${count}x ${item}`)
      .join(", ");
  }
}

// ============================================================================
// REAL VOYAGER EXECUTOR (connects to Python Voyager bot)
// ============================================================================

class VoyagerExecutor {
  constructor(voyagerPath, openaiKey, agentId = "1") {
    this.voyagerPath = voyagerPath;
    this.openaiKey = openaiKey;
    this.agentId = agentId;
    this.currentProcess = null;
    this.taskQueue = [];
    this.isBusy = false;
  }

  async executeTask(command, statusCallback) {
    console.log(`\n[Real Voyager] Executing task...`);
    console.log(`Agent: ${getAgentLabel(this.agentId)}`);
    console.log(`Task: "${command}"`);

    const safeTask = escapePythonTripleQuotedString(command);
    const safeVoyagerPath = escapePythonTripleQuotedString(this.voyagerPath);
    const safeApiKey = escapePythonTripleQuotedString(this.openaiKey);

    const pythonScript = `
import sys
import os

sys.path.insert(0, "${safeVoyagerPath}")

from voyager import Voyager

azure_login = {
    "client_id": os.getenv("AZURE_CLIENT_ID", "YOUR_CLIENT_ID"),
    "redirect_url": "https://127.0.0.1/auth-response",
    "version": "fabric-loader-0.14.18-1.19",
}

print("[VOYAGER] Agent ${this.agentId}: Initializing...")

voyager = Voyager(
    azure_login=azure_login,
    openai_api_key="${safeApiKey}",
    ckpt_dir="./ckpt/agent_${this.agentId}",
    resume=False,
)

task = """${safeTask}"""

print(f"[VOYAGER] Agent ${this.agentId}: Task: {task}")

try:
    print("[VOYAGER] Agent ${this.agentId}: Decomposing task into sub-goals...")
    sub_goals = voyager.decompose_task(task=task)
    print(f"[VOYAGER] Agent ${this.agentId}: Sub-goals: {sub_goals}")
    print("[VOYAGER] Agent ${this.agentId}: Executing in Minecraft...")
    voyager.inference(sub_goals=sub_goals)
    print("[VOYAGER] Agent ${this.agentId}: ✅ Task completed successfully!")
except Exception as e:
    print(f"[VOYAGER] Agent ${this.agentId}: ❌ Error: {e}")
    sys.exit(1)
`;

    const tempFile = path.join(
      __dirname,
      `temp_voyager_agent_${this.agentId}_${Date.now()}.py`
    );
    fs.writeFileSync(tempFile, pythonScript);

    return new Promise((resolve, reject) => {
      this.isBusy = true;

      this.currentProcess = spawn("python3", [tempFile], {
        cwd: this.voyagerPath,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          AGENT_ID: this.agentId,
        },
      });

      let output = "";

      this.currentProcess.stdout.on("data", async (data) => {
        const text = data.toString();
        output += text;

        console.log(`[Voyager Agent ${this.agentId}]:`, text.trim());

        if (text.includes("[VOYAGER]")) {
          const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

          for (const line of lines) {
            if (line.includes("[VOYAGER]") && statusCallback) {
              const status = line.replace("[VOYAGER]", "").trim();
              await statusCallback(`🤖 ${status}`);
            }
          }
        }
      });

      this.currentProcess.stderr.on("data", (data) => {
        const text = data.toString();
        output += text;
        console.error(`[Voyager Agent ${this.agentId} Error]:`, text.trim());
      });

      this.currentProcess.on("close", async (code) => {
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // ignore cleanup errors
        }

        this.isBusy = false;
        this.currentProcess = null;

        if (code === 0) {
          console.log(`✅ Voyager task completed successfully for Agent ${this.agentId}`);
          resolve({ success: true, result: output });
        } else {
          console.log(`❌ Voyager task failed for Agent ${this.agentId} (exit code: ${code})`);
          reject(new Error(`Voyager failed with exit code ${code}`));
        }

        if (this.taskQueue.length > 0) {
          const next = this.taskQueue.shift();
          this.executeTask(next.command, next.statusCallback).catch(console.error);
        }
      });
    });
  }

  stop() {
    if (this.currentProcess) {
      this.currentProcess.kill();
    }
  }
}

// ============================================================================
// MULTI-AGENT MANAGER
// ============================================================================

class MultiVoyagerExecutor {
  constructor(voyagerPath, openaiKey) {
    this.voyagerPath = voyagerPath;
    this.openaiKey = openaiKey;
    this.executors = new Map(); // lazy creation
  }

  getExecutor(agentId) {
    if (!this.executors.has(agentId)) {
      this.executors.set(
        agentId,
        new VoyagerExecutor(this.voyagerPath, this.openaiKey, agentId)
      );
    }
    return this.executors.get(agentId);
  }

  async executeForAgent(agentId, command, statusCallback) {
    const executor = this.getExecutor(agentId);

    if (executor.isBusy) {
      executor.taskQueue.push({ command, statusCallback });
      return { queued: true, position: executor.taskQueue.length };
    }

    executor.executeTask(command, statusCallback).catch(console.error);
    return { queued: false, position: 0 };
  }

  stop() {
    for (const executor of this.executors.values()) {
      executor.stop();
    }
  }
}

// ============================================================================
// MAIN BOT
// ============================================================================

let executor = null;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║ iMessage → Voyager Minecraft Integration                    ║");
  console.log(`║ Mode: ${SIMULATION_MODE ? "SIMULATION" : "REAL MINECRAFT"}                                     ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  let voyager;
  if (SIMULATION_MODE) {
    console.log("Using SIMULATION mode (no Minecraft needed)");
    voyager = new VoyagerSimulator();
  } else {
    console.log("Using REAL Voyager mode");
    console.log(`Voyager path: ${VOYAGER_PATH}`);
    voyager = new MultiVoyagerExecutor(VOYAGER_PATH, OPENAI_API_KEY);
    executor = voyager;
  }

  console.log("Connecting to iMessage...");
  const app = await Spectrum({
    providers: [imessage.config({ local: true })],
  });

  console.log("✅ Connected!\n");
  console.log("Monitoring group chats for commands\n");
  console.log("Example commands to try in a GROUP CHAT:");
  console.log("• 'agent 1 mine iron ore'");
  console.log("• 'agents 1,2 build a shelter'");
  console.log("• 'all agents chop wood'\n");
  console.log("Listening for messages...\n");

  const seenMessages = new Set();

  for await (const [space, message] of app.messages) {
    try {
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);

      if (message.sender.id === MY_NUMBER || message.sender.id === "") {
        continue;
      }

      if (!isGroupChat(space)) {
        continue;
      }

      if (message.content.type !== "text") continue;

      const content = (message.content.text || "").trim();
      const sender = message.sender.name || message.sender.id;

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`[${sender}]: ${content}`);

      const sendToGroup = async (text) => {
        console.log(`${text}`);
        await space.send(text);
      };

      if (
        content.toLowerCase().includes("inventory") ||
        content.toLowerCase().includes("status")
      ) {
        if (SIMULATION_MODE) {
          const inventory = voyager.getInventoryStatus();
          const statusMsg = inventory
            ? `Current Inventory: ${inventory}`
            : `Inventory is empty`;
          await sendToGroup(statusMsg);
        } else {
          await sendToGroup("Status check not available in real mode yet");
        }
        continue;
      }

      const parsed = parseTargetedCommand(content);

      if (parsed) {
        const { targets, command } = parsed;

        if (SIMULATION_MODE) {
          for (const agentId of targets) {
            const result = await voyager.executeTask(agentId, command);
            const response = result.success
              ? `🤖 ${getAgentLabel(agentId)}: ${result.result}`
              : `🤖 ${getAgentLabel(agentId)}: ❌ ${result.error}`;
            await sendToGroup(response);
          }
        } else {
          await sendToGroup(
            `Dispatching "${command}" to ${targets
              .map((id) => getAgentLabel(id))
              .join(", ")}`
          );

          const results = await Promise.all(
            targets.map((agentId) =>
              voyager
                .executeForAgent(agentId, command, async (status) => {
                  await sendToGroup(status);
                })
                .then((result) => ({ agentId, result }))
            )
          );

          for (const { agentId, result } of results) {
            if (result.queued) {
              await sendToGroup(
                `🤖 ${getAgentLabel(agentId)}: Task queued (position: ${result.position})`
              );
            }
          }
        }
      } else {
        const helpMsg =
          "Target agents explicitly:\n" +
          "• agent 1 chop wood\n" +
          "• agents 1,2 chop wood\n" +
          "• all agents chop wood";
        await sendToGroup(helpMsg);
      }
    } catch (error) {
      console.error("❌ Error:", error.message);
    }
  }
}

// ============================================================================
// START
// ============================================================================

process.on("SIGINT", () => {
  console.log("\n\nShutting down gracefully...");
  if (executor && !SIMULATION_MODE) {
    executor.stop();
  }
  process.exit(0);
});

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});

console.log("\nSETUP INSTRUCTIONS:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Current Mode:", SIMULATION_MODE ? "SIMULATION ✅" : "REAL MINECRAFT");

if (!SIMULATION_MODE) {
  console.log("\nReal Mode Requirements:");
  console.log(
    "1. Clone Voyager repo: git clone https://github.com/MarcDasilva/HackPrincetonSpring2026 -b voyager"
  );
  console.log("2. Install Python 3.9+ and Voyager: pip install -e .");
  console.log("3. Set environment variables:");
  console.log("   export VOYAGER_PATH=/path/to/HackPrincetonSpring2026");
  console.log("   export OPENAI_API_KEY=your_key_here");
  console.log("4. Start Minecraft (Fabric 1.19) and create world");
  console.log("5. Open world to LAN with cheats ON");
}

console.log("\nUsage:");
console.log("• Send messages in your iMessage GROUP CHAT");
console.log("• Examples:");
console.log("  - 'agent 1 mine iron ore'");
console.log("  - 'agents 1,2 build a house'");
console.log("  - 'all agents chop wood'");
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");