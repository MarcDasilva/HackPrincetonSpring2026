/**
 * Advanced iMessage Bot - Multi-Agent Example
 *
 * Each agent runs as a separate Minecraft bot with its own username,
 * bridge port, and checkpoint directory so they appear as distinct
 * players with individual skins.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VOYAGER_PATH = process.env.VOYAGER_PATH || path.join(__dirname, "voyager");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MC_PORT = parseInt(process.env.VOYAGER_MC_PORT || "25565", 10);
const BASE_SERVER_PORT = parseInt(process.env.VOYAGER_SERVER_PORT || "3000", 10);

function getPhotonCredentials() {
  const projectId = process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID;
  const projectSecret =
    process.env.PHOTON_PROJECT_SECRET ||
    process.env.PROJECT_SECRET ||
    process.env.SECRET_KEY;
  return { projectId, projectSecret, enabled: Boolean(projectId && projectSecret) };
}

// ============================================================================
// AGENT DEFINITIONS
// Each agent gets a unique bot_username, server_port, ckpt_dir, and
// visual equipment so they look distinct in-game without Mojang accounts.
//
// equipment slots: armor.head, armor.chest, armor.legs, armor.feet,
//                  weapon.mainhand, weapon.offhand
// ============================================================================

const agents = {
  planner: {
    name: "Planner",
    botUsername: "Strategist",
    serverPort: BASE_SERVER_PORT,
    ckptDir: path.join(__dirname, "ckpt-planner"),
    keywords: ["plan", "strategy", "organize", "coordinate"],
    equipment: {
      "armor.head": 'leather_helmet{display:{color:4915330}}',
      "armor.chest": 'leather_chestplate{display:{color:4915330}}',
      "armor.legs": 'leather_leggings{display:{color:4915330}}',
      "armor.feet": 'leather_boots{display:{color:4915330}}',
    },
    respond: () => {
      const responses = [
        `[Planner]: Oh nice, I love a good puzzle! Let me break this down for you real quick.`,
        `[Planner]: Ooh okay okay, give me a sec to think through this one. I have ideas already!`,
        `[Planner]: Yes!! I was hoping someone would ask. Let me map this out step by step.`,
        `[Planner]: Alright alright, leave the thinking to me. I'll get us a solid game plan.`,
      ];
      return responses[Math.floor(Math.random() * responses.length)];
    }
  },
  builder: {
    name: "Builder",
    botUsername: "Builder",
    serverPort: BASE_SERVER_PORT + 1,
    ckptDir: path.join(__dirname, "ckpt-builder"),
    keywords: ["build", "construct", "create", "craft", "make", "place"],
    equipment: {
      "armor.head": 'leather_helmet{display:{color:8421504}}',
      "armor.chest": 'leather_chestplate{display:{color:8421504}}',
      "armor.legs": 'leather_leggings{display:{color:8421504}}',
      "armor.feet": 'leather_boots{display:{color:8421504}}',
    },
    respond: () => {
      const responses = [
        `[Builder]: Understood. Checking materials and starting construction.`,
        `[Builder]: Acknowledged. I will assess the requirements and begin.`,
        `[Builder]: Copy. Pulling up the blueprint now.`,
        `[Builder]: On it. I will report back when it is done.`,
      ];
      return responses[Math.floor(Math.random() * responses.length)];
    }
  },
  miner: {
    name: "Miner",
    botUsername: "Miner",
    serverPort: BASE_SERVER_PORT + 2,
    ckptDir: path.join(__dirname, "ckpt-miner"),
    keywords: ["mine", "gather", "collect", "dig", "find", "get"],
    equipment: {
      "armor.head": "leather_helmet",
      "armor.chest": "leather_chestplate",
      "armor.legs": "leather_leggings",
      "armor.feet": "leather_boots",
    },
    respond: () => {
      const responses = [
        `[Miner]: Heading down. I will get what we need.`,
        `[Miner]: Resources noted. Moving to gather.`,
        `[Miner]: Understood. Beginning extraction now.`,
        `[Miner]: I know where to look. Stand by.`,
      ];
      return responses[Math.floor(Math.random() * responses.length)];
    }
  }
};

// ============================================================================
// PER-AGENT VOYAGER EXECUTOR
// Each agent has its own executor so they can run tasks in parallel.
// ============================================================================

class AgentExecutor {
  constructor(agentKey) {
    const agent = agents[agentKey];
    this.agentKey = agentKey;
    this.botUsername = agent.botUsername;
    this.serverPort = agent.serverPort;
    this.ckptDir = agent.ckptDir;
    this.equipment = agent.equipment || {};
    this.currentProcess = null;
    this.taskQueue = [];
    this.isBusy = false;
  }

  _buildEquipCommands() {
    return Object.entries(this.equipment)
      .map(([slot, item]) =>
        `voyager.env.step('bot.chat("/item replace entity @s ${slot} with minecraft:${item}");')`
      )
      .join("\n");
  }

  async executeTask(command, statusCallback) {
    console.log(`\n[${this.botUsername}] Executing: "${command}"`);
    console.log(`  bridge port: ${this.serverPort}, ckpt: ${this.ckptDir}`);

    const equipCommands = this._buildEquipCommands();

    const pythonScript = `
import sys, os
sys.path.insert(0, "${VOYAGER_PATH}")
from voyager import Voyager

print("[VOYAGER] Initializing ${this.botUsername}...")
voyager = Voyager(
    mc_port=${MC_PORT},
    server_port=${this.serverPort},
    bot_username="${this.botUsername}",
    openai_api_key="${OPENAI_API_KEY}",
    ckpt_dir="${this.ckptDir}",
    resume=False,
)

print("[VOYAGER] Equipping ${this.botUsername}...")
${equipCommands}

task = """${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"""
print(f"[VOYAGER] Task: {task}")

try:
    print("[VOYAGER] Decomposing task...")
    sub_goals = voyager.decompose_task(task=task)
    print(f"[VOYAGER] Sub-goals: {sub_goals}")
    print("[VOYAGER] Executing in Minecraft...")
    voyager.inference(sub_goals=sub_goals)
    print("[VOYAGER] Task completed successfully!")
except Exception as e:
    print(f"[VOYAGER] Error: {e}")
    sys.exit(1)
`;

    const tempFile = path.join(__dirname, `temp_voyager_${this.agentKey}_${Date.now()}.py`);
    fs.writeFileSync(tempFile, pythonScript);

    return new Promise((resolve, reject) => {
      this.isBusy = true;
      this.currentProcess = spawn("python3", [tempFile], {
        cwd: VOYAGER_PATH,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      let output = "";

      this.currentProcess.stdout.on("data", async (data) => {
        const text = data.toString();
        output += text;
        console.log(`[${this.botUsername}]:`, text.trim());
        if (text.includes("[VOYAGER]") && statusCallback) {
          const status = text.split("[VOYAGER]")[1].trim();
          await statusCallback(`[${this.botUsername}] ${status}`);
        }
      });

      this.currentProcess.stderr.on("data", (data) => {
        console.error(`[${this.botUsername} err]:`, data.toString());
      });

      this.currentProcess.on("close", (code) => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        this.isBusy = false;
        this.currentProcess = null;

        if (code === 0) {
          resolve({ success: true, result: output });
        } else {
          reject(new Error(`${this.botUsername} failed with exit code ${code}`));
        }

        if (this.taskQueue.length > 0) {
          const next = this.taskQueue.shift();
          this.executeTask(next.command, next.statusCallback).catch((err) => {
            console.error(`[${this.botUsername}] queued task error:`, err.message);
          });
        }
      });
    });
  }

  queueTask(command, statusCallback) {
    if (this.isBusy) {
      this.taskQueue.push({ command, statusCallback });
      return this.taskQueue.length;
    }
    this.executeTask(command, statusCallback).catch((err) => {
      console.error(`[${this.botUsername}] task error:`, err.message);
    });
    return 0;
  }

  stop() {
    if (this.currentProcess) {
      this.currentProcess.kill();
    }
  }
}

// ============================================================================
// ROUTING
// ============================================================================

function routeToAgent(text) {
  const lower = text.toLowerCase();
  for (const [key, agent] of Object.entries(agents)) {
    for (const kw of agent.keywords) {
      if (lower.includes(kw)) return key;
    }
  }
  return null;
}

// Parse commands from messages
function parseCommand(text) {
  const agentKey = routeToAgent(text);
  if (agentKey) return { agent: agentKey, command: text };

  const lowerText = text.toLowerCase();
  if (lowerText.includes("help") || lowerText.includes("?")) {
    return { agent: "help", command: text };
  }
  return { agent: "all", command: text };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("Starting Multi-Agent iMessage Bot...\n");

  const executors = {};
  for (const key of Object.keys(agents)) {
    executors[key] = new AgentExecutor(key);
    console.log(`  ${agents[key].botUsername} -> port ${agents[key].serverPort}, ckpt ${agents[key].ckptDir}`);
  }
  console.log("");

  const photon = getPhotonCredentials();
  const app = await Spectrum(
    photon.enabled
      ? {
          projectId: photon.projectId,
          projectSecret: photon.projectSecret,
          providers: [imessage.config()],
        }
      : {
          providers: [imessage.config({ local: true })],
        }
  );

  console.log(photon.enabled
    ? "Connected with Photon cloud! Available agents:"
    : "Connected in local mode! Available agents:");
  for (const agent of Object.values(agents)) {
    console.log(`   ${agent.name} (username: ${agent.botUsername}, port: ${agent.serverPort})`);
  }
  console.log("\nListening for messages...\n");

  const seenMessages = new Set();
  const myNumber = process.env.IMESSAGE_BOT_ID || "";

  for await (const [space, message] of app.messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);

    if (message.sender.id === myNumber || message.sender.id === "") continue;
    if (message.content.type !== "text") continue;

    const text = message.content.text.trim();
    if (!text) continue;

    const { agent, command } = parseCommand(text);

    console.log(`From: ${message.sender.id}`);
    console.log(`  Message: "${text}"`);
    console.log(`  Routing to: ${agent}\n`);

    if (agent === "help") {
      await space.send(
        "Multi-Agent Bot Commands:\n\n" +
        "Send 'plan [task]' to talk to the Planner\n" +
        "Send 'build [item]' to talk to the Builder\n" +
        "Send 'mine [resource]' to talk to the Miner\n" +
        "Send 'help' for this message\n\n" +
        "Example: 'plan a survival base'"
      );
      continue;
    }

    if (agent !== "all" && agents[agent]) {
      const response = agents[agent].respond();
      await space.send(response);
      executors[agent].queueTask(command, null);
    } else {
      await space.send(
        "All agents standing by. Ask me to:\n" +
        "Plan something\n" +
        "Build something\n" +
        "Mine or gather resources\n" +
        "Or type 'help' for more info"
      );
    }
  }
}

process.on("SIGINT", () => {
  console.log("\nShutting down multi-agent bot...");
  process.exit(0);
});

main().catch(console.error);
