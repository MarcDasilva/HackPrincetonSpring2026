/**
 * iMessage → Voyager Minecraft Integration
 * 
 * Bridges iMessage group chat with Python Voyager bot for REAL Minecraft control
 * 
 * Flow:
 * 1. You send command in iMessage: "mine iron ore"
 * 2. Routes to Miner agent: ⛏️ Miner  
 * 3. Executes REAL Voyager Python task in Minecraft
 * 4. Sends updates back to iMessage: "⛏️ Miner: Mining iron ore..."
 * 
 * Requirements:
 * - Voyager repo cloned from: https://github.com/MarcDasilva/HackPrincetonSpring2026 (voyager branch)
 * - Python 3.9+ with Voyager installed
 * - OpenAI API key (GPT-4)
 * - Minecraft running with Fabric mods
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

// ============================================================================
// CONFIGURATION
// ============================================================================

const MY_NUMBER = "+19054629158";
const SIMULATION_MODE = false; // ← Set to false when Voyager is fully setup (NOW READY!)
const VOYAGER_PATH = process.env.VOYAGER_PATH || "/Users/williamzhang/Hackathon!!/voyager-repo"; // Path to Voyager repo
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "YOUR_API_KEY_HERE";
const IMESSAGE_BOT_ID = process.env.IMESSAGE_BOT_ID || MY_NUMBER;

// Group Chat Members - used when Photon cloud mode is enabled for group creation
const GROUP_MEMBERS = [
  "+19054629158", // Your number
  // Add more numbers:
  // "+1234567890",
  // "+0987654321",
];

// All available agent definitions
const AGENT_DEFINITIONS = {
  planner: {
    name: "🧠 Planner",
    emoji: "🧠",
    description: "Strategy, planning, coordination",
    keywords: ["plan", "strategy", "organize", "coordinate", "what should", "how to"],
    simResponses: [
      "Analyzed terrain - found optimal location at (100, 64, -200)",
      "Strategy complete: Need 64 wood, 32 cobblestone, 16 iron",
      "Planned route: Mine → Crafting Table → Forest",
      "Coordinating team: Miner gets resources, Builder constructs",
    ],
  },
  builder: {
    name: "🏗️ Builder",
    emoji: "🏗️",
    description: "Building, crafting, construction",
    keywords: ["build", "construct", "create", "craft", "make", "place"],
    simResponses: [
      "Built structure successfully! Used 24 wood planks",
      "Crafted 3 tools: pickaxe, axe, sword",
      "Constructed shelter at base coordinates",
      "Placed crafting table and furnace",
    ],
  },
  miner: {
    name: "⛏️ Miner",
    emoji: "⛏️",
    description: "Mining, gathering, resource collection",
    keywords: ["mine", "gather", "collect", "dig", "find", "get"],
    simResponses: [
      "Mined 16 iron ore from depth Y=12",
      "Collected 64 cobblestone blocks",
      "Found diamond at (45, 11, -89)!",
      "Gathered 32 oak wood logs",
    ],
  },
  explorer: {
    name: "🗺️ Explorer",
    emoji: "🗺️",
    description: "Exploring, scouting, map discovery",
    keywords: ["explore", "scout", "map", "discover", "navigate", "where", "find area"],
    simResponses: [
      "Explored 500 blocks north - found desert biome",
      "Scouted location: stronghold at (234, 45, -678)",
      "Discovered village 300 blocks east",
      "Mapped cave system, 3 exits found",
    ],
  },
  farmer: {
    name: "🌾 Farmer",
    emoji: "🌾",
    description: "Farming, food, crops, animals",
    keywords: ["farm", "grow", "harvest", "food", "crop", "animal", "breed"],
    simResponses: [
      "Planted 16 wheat seeds, ready in ~5 min",
      "Harvested 32 carrots and 16 potatoes",
      "Built animal pen with 4 cows and 3 sheep",
      "Composted materials, gained 8 bone meal",
    ],
  },
};

// Per-group agent registry: spaceId → Set of agent keys
const groupAgents = new Map();

function getGroupAgents(spaceId) {
  if (!groupAgents.has(spaceId)) {
    // Default: empty — require /addagent before routing any messages
    groupAgents.set(spaceId, new Set());
  }
  return groupAgents.get(spaceId);
}

// Legacy alias used elsewhere in the file
const agents = AGENT_DEFINITIONS;

function getPhotonCredentials() {
  const projectId = process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID;
  const projectSecret =
    process.env.PHOTON_PROJECT_SECRET ||
    process.env.PROJECT_SECRET ||
    process.env.SECRET_KEY;

  return {
    projectId,
    projectSecret,
    enabled: Boolean(projectId && projectSecret),
  };
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

  async executeTask(agentType, command) {
    this.taskCount++;
    console.log(`\n🎮 [Voyager Sim] Task #${this.taskCount}`);
    console.log(`   Agent: ${agents[agentType].name}`);
    console.log(`   Command: "${command}"`);

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

    // Get random response from agent's pool
    const responses = agents[agentType].simResponses;
    const response = responses[Math.floor(Math.random() * responses.length)];

    // Update simulated inventory
    this.updateInventory(response);

    // 90% success rate
    const success = Math.random() > 0.1;

    if (success) {
      console.log(`   ✅ Success: ${response}`);
      return { success: true, result: response };
    } else {
      console.log(`   ❌ Failed: Task error`);
      return { success: false, error: "Ran out of resources or got stuck" };
    }
  }

  updateInventory(response) {
    // Parse response to update inventory
    const match = response.match(/(\d+)\s+(\w+)/);
    if (match) {
      const [, count, item] = match;
      const normalizedItem = item.toLowerCase().replace(/\s+/g, "_");
      if (this.inventory.hasOwnProperty(normalizedItem)) {
        this.inventory[normalizedItem] += parseInt(count);
      }
    }
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
  constructor(voyagerPath, openaiKey) {
    this.voyagerPath = voyagerPath;
    this.openaiKey = openaiKey;
    this.currentProcess = null;
    this.taskQueue = [];
    this.isBusy = false;
  }

  async executeTask(agentType, command, statusCallback) {
    console.log(`\n🤖 [Real Voyager] Executing task...`);
    console.log(`   Agent: ${agents[agentType].name}`);
    console.log(`   Task: "${command}"`);

    // Create Python script that runs Voyager
    const pythonScript = `
import sys
import os
sys.path.insert(0, "${this.voyagerPath}")

from voyager import Voyager

print("[VOYAGER] Initializing...")
voyager = Voyager(
    mc_port=25565,
    openai_api_key="${this.openaiKey}",
    ckpt_dir="./ckpt",
    resume=False,
)

# Execute task
task = """${command.replace(/"/g, '\\"')}"""
print(f"[VOYAGER] Task: {task}")

try:
    print("[VOYAGER] Decomposing task into sub-goals...")
    sub_goals = voyager.decompose_task(task=task)
    print(f"[VOYAGER] Sub-goals: {sub_goals}")
    
    print("[VOYAGER] Executing in Minecraft...")
    voyager.inference(sub_goals=sub_goals)
    print("[VOYAGER] ✅ Task completed successfully!")
except Exception as e:
    print(f"[VOYAGER] ❌ Error: {e}")
    sys.exit(1)
`;

    // Write to temp file
    const tempFile = path.join(__dirname, `temp_voyager_${Date.now()}.py`);
    fs.writeFileSync(tempFile, pythonScript);

    return new Promise((resolve, reject) => {
      this.isBusy = true;
      this.currentProcess = spawn('python3', [tempFile], {
        cwd: this.voyagerPath,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      let output = '';

      this.currentProcess.stdout.on('data', async (data) => {
        const text = data.toString();
        output += text;
        console.log('[Voyager]:', text.trim());

        // Send status updates back to iMessage
        if (text.includes('[VOYAGER]')) {
          const status = text.split('[VOYAGER]')[1].trim();
          if (statusCallback) {
            await statusCallback(`${agents[agentType].emoji} ${status}`);
          }
        }
      });

      this.currentProcess.stderr.on('data', (data) => {
        console.error('[Voyager Error]:', data.toString());
      });

      this.currentProcess.on('close', async (code) => {
        // Clean up temp file
        try { fs.unlinkSync(tempFile); } catch(e) {}
        
        this.isBusy = false;
        this.currentProcess = null;

        if (code === 0) {
          console.log('   ✅ Voyager task completed successfully');
          resolve({ success: true, result: output });
        } else {
          console.log(`   ❌ Voyager task failed (exit code: ${code})`);
          reject(new Error(`Voyager failed with exit code ${code}`));
        }

        // Process next queued task
        if (this.taskQueue.length > 0) {
          const next = this.taskQueue.shift();
          this.executeTask(next.agentType, next.command, next.statusCallback);
        }
      });
    });
  }

  queueTask(agentType, command, statusCallback) {
    if (this.isBusy) {
      this.taskQueue.push({ agentType, command, statusCallback });
      return this.taskQueue.length;
    } else {
      this.executeTask(agentType, command, statusCallback).catch((err) => {
        console.error('[Voyager] Task error (non-fatal):', err.message);
      });
      return 0;
    }
  }

  stop() {
    if (this.currentProcess) {
      this.currentProcess.kill();
    }
  }
}

// ============================================================================
// AGENT ROUTER
// ============================================================================

function routeToAgent(message, spaceId) {
  const lowerMsg = message.toLowerCase();
  const activeAgents = spaceId ? getGroupAgents(spaceId) : new Set(Object.keys(AGENT_DEFINITIONS));

  for (const [agentType, agent] of Object.entries(agents)) {
    if (!activeAgents.has(agentType)) continue; // skip if not registered in this group
    for (const keyword of agent.keywords) {
      if (lowerMsg.includes(keyword)) {
        return { agentType, agent };
      }
    }
  }

  return null;
}

// ============================================================================
// COLLABORATION DETECTOR
// ============================================================================

function needsCollaboration(message) {
  const complexTasks = [
    "base",
    "house",
    "farm",
    "survive",
    "prepare for night",
    "setup",
    "village",
  ];

  const lowerMsg = message.toLowerCase();
  return complexTasks.some((task) => lowerMsg.includes(task));
}

// ============================================================================
// GROUP CHAT MANAGEMENT
// ============================================================================

/**
 * Create or get existing group chat with specified members
 * @param {Spectrum} app - Spectrum app instance
 * @param {string[]} members - Array of phone numbers
 * @returns {Promise<Space>} - Group chat space
 */
async function getOrCreateGroupChat(app, members) {
  try {
    console.log(`📱 Creating group chat with members: ${members.join(", ")}`);
    const im = imessage(app);
    const users = await Promise.all(
      [...new Set(members)].map((member) => im.user(member))
    );
    const space = await im.space(...users);
    console.log(`✅ Group chat ready: ${space.id}`);
    return space;
  } catch (error) {
    console.error("❌ Error creating group chat:", error.message);
    throw error;
  }
}

// ============================================================================
// MAIN BOT
// ============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║      iMessage → Voyager Minecraft Integration               ║");
  console.log(`║      Mode: ${SIMULATION_MODE ? 'SIMULATION' : 'REAL MINECRAFT'}                            ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Initialize executor (simulator or real Voyager)
  let voyager;
  if (SIMULATION_MODE) {
    console.log("🎮 Using SIMULATION mode (no Minecraft needed)");
    voyager = new VoyagerSimulator();
  } else {
    console.log("🤖 Using REAL Voyager mode");
    console.log(`📁 Voyager path: ${VOYAGER_PATH}`);
    voyager = new VoyagerExecutor(VOYAGER_PATH, OPENAI_API_KEY);
  }

  // Initialize Spectrum iMessage Client
  console.log("📱 Connecting to iMessage...");

  let app;
  const photon = getPhotonCredentials();
  if (photon.enabled) {
    app = await Spectrum({
      projectId: photon.projectId,
      projectSecret: photon.projectSecret,
      providers: [imessage.config({})],
    });
    console.log("☁️  Using Photon Spectrum cloud (DMs + Group Chats supported)");
  } else {
    app = await Spectrum({
      providers: [imessage.config({ local: true })],
    });
    console.log("💻 Using local iMessage mode (DMs only)");
    console.log("   Set PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET to enable cloud group chats.");
  }
  console.log("");

  // Create or get group chat if GROUP_MEMBERS has multiple people
  let mainGroupChat = null;
  if (GROUP_MEMBERS.length > 1) {
    if (!photon.enabled) {
      console.log("⚠️  Skipping group chat setup: local iMessage mode cannot create groups.");
      console.log("   Use Photon cloud credentials for group chat support.\n");
    } else {
      console.log(`👥 Setting up group chat with ${GROUP_MEMBERS.length} members...`);
      mainGroupChat = await getOrCreateGroupChat(app, GROUP_MEMBERS);
      console.log(`✅ Group chat ready!\n`);
      
      // Send welcome message to group
      await mainGroupChat.send("🤖 Minecraft AI is online! Send commands like 'mine iron ore' or 'build a house'");
    }
  }

  console.log(photon.enabled ? "💬 Monitoring group chats for commands\n" : "💬 Monitoring chats for commands\n");
  console.log(`📝 Example commands to try ${photon.enabled ? "in a GROUP CHAT" : "in your chat"}:`);
  console.log("   • 'mine iron ore'");
  console.log("   • 'build a shelter'");
  console.log("   • 'plan a survival strategy'");
  console.log("   • 'build a base' (triggers multi-agent collaboration)\n");
  console.log("👁️  Listening for messages...\n");

  const seenMessages = new Set();

  // Track chats we've already welcomed so we only send the intro once
  const welcomedSpaces = new Set();

  for await (const [space, message] of app.messages) {
    try {
      // Skip duplicates
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);

      // Only handle text messages
      if (message.content.type !== "text") continue;

      const content = message.content.text?.trim() || "";
      if (!content) continue;

      // Skip our own looped-back sends to avoid responding to ourselves.
      if (message.sender.id === IMESSAGE_BOT_ID || message.sender.id === "") continue;

      const sender = message.sender.name || message.sender.id;

      console.log(`\n📨 [${sender}]: ${content}`);

      const reply = async (text) => {
        console.log(`📤 ${text}`);
        await space.send(text);
      };

      // ── /addagent — adds an agent to THIS chat ────────────────────────────
      if (content.startsWith("/addagent")) {
        const agentKey = content.split(" ")[1]?.toLowerCase();
        if (agentKey && AGENT_DEFINITIONS[agentKey]) {
          getGroupAgents(space.id).add(agentKey);
          const a = AGENT_DEFINITIONS[agentKey];

          // First time any agent is added to this chat → send welcome
          if (!welcomedSpaces.has(space.id)) {
            welcomedSpaces.add(space.id);
            await reply(
              `${a.emoji} ${a.name} has joined the chat!\n\n` +
              `I can control a Minecraft bot. Just say something like:\n` +
              `"${a.keywords[0]} ..." and I'll handle it in Minecraft.\n\n` +
              `Add more agents with /addagent [name]\n` +
              `Available: miner, builder, planner, explorer, farmer`
            );
          } else {
            await reply(`${a.emoji} ${a.name} has joined the chat! (${a.description})`);
          }
        } else {
          const available = Object.entries(AGENT_DEFINITIONS)
            .map(([k, a]) => `${a.emoji} ${k}`)
            .join(", ");
          await reply(`❓ Unknown agent. Available: ${available}`);
        }
        continue;
      }

      // ── /removeagent ──────────────────────────────────────────────────────
      if (content.startsWith("/removeagent")) {
        const agentKey = content.split(" ")[1]?.toLowerCase();
        if (agentKey && AGENT_DEFINITIONS[agentKey]) {
          getGroupAgents(space.id).delete(agentKey);
          const a = AGENT_DEFINITIONS[agentKey];
          await reply(`🗑️ ${a.emoji} ${a.name} has left the chat.`);
        } else {
          await reply(`❓ Unknown agent: ${agentKey}`);
        }
        continue;
      }

      // ── /agents — list what's active in this chat ─────────────────────────
      if (content === "/agents") {
        const active = getGroupAgents(space.id);
        if (active.size === 0) {
          await reply("No agents added yet. Use /addagent [name] to add one.\nAvailable: miner, builder, planner, explorer, farmer");
        } else {
          const list = [...active].map(k => `${AGENT_DEFINITIONS[k].emoji} ${k}`).join(", ");
          await reply(`🤖 Active agents: ${list}`);
        }
        continue;
      }

      // ── /help ─────────────────────────────────────────────────────────────
      if (content === "/help") {
        await reply(
          "🤖 Commands:\n" +
          "/addagent [name] — add an agent to this chat\n" +
          "/removeagent [name] — remove an agent\n" +
          "/agents — list active agents\n\n" +
          "Once an agent is added, just type naturally:\n" +
          "'mine iron ore', 'build a shelter', 'plan a base'"
        );
        continue;
      }

      // ── Only route if at least one agent has been added to this chat ──────
      const activeAgents = getGroupAgents(space.id);
      if (activeAgents.size === 0) continue; // no agents here — ignore

      const routing = routeToAgent(content, space.id);
      if (!routing) continue; // message didn't match any agent keyword — ignore

      const { agentType, agent } = routing;
      console.log(`🎯 → ${agent.name}: "${content}"`);

      // Confirm to the user, then run Voyager silently (no further updates)
      await reply(`${agent.emoji} ${agent.name}: on it!`);

      voyager.queueTask(agentType, content, null); // null = no iMessage callbacks

    } catch (error) {
      console.error("❌ Error:", error.message);
    }
  }
}

// ============================================================================
// START
// ============================================================================

let executor = null;

process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down gracefully...");
  if (executor && !SIMULATION_MODE) {
    executor.stop();
  }
  process.exit(0);
});

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});

console.log("\n📋 SETUP INSTRUCTIONS:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Current Mode:", SIMULATION_MODE ? "SIMULATION ✅" : "REAL MINECRAFT");
if (!SIMULATION_MODE) {
  console.log("\n🔧 Real Mode Requirements:");
  console.log("  1. Clone Voyager repo: git clone https://github.com/MarcDasilva/HackPrincetonSpring2026 -b voyager");
  console.log("  2. Install Python 3.9+ and Voyager: pip install -e .");
  console.log("  3. Set environment variables:");
  console.log("     export VOYAGER_PATH=/path/to/HackPrincetonSpring2026");
  console.log("     export OPENAI_API_KEY=your_key_here");
  console.log("  4. Start Minecraft (Fabric 1.19) and create world");
  console.log("  5. Open world to LAN with cheats ON");
}
console.log("\n📱 Usage:");
console.log("  • Send messages in your iMessage GROUP CHAT");
console.log("  • Examples:");
console.log("    - 'mine iron ore'");
console.log("    - 'build a house'");
console.log("    - 'plan survival strategy'");
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
