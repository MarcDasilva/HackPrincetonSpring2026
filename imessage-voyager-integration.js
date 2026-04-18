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
const VOYAGER_PATH = process.env.VOYAGER_PATH || "/Users/williamzhang/Hackathon!!/hackPrinceton"; // Path to Voyager repo (current directory)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "YOUR_API_KEY_HERE";

// Agent Configurations
const agents = {
  planner: {
    name: "🧠 Planner",
    emoji: "🧠",
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
    keywords: ["mine", "gather", "collect", "dig", "find", "get"],
    simResponses: [
      "Mined 16 iron ore from depth Y=12",
      "Collected 64 cobblestone blocks",
      "Found diamond at (45, 11, -89)!",
      "Gathered 32 oak wood logs",
    ],
  },
};

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

# Configure Voyager
azure_login = {
    "client_id": os.getenv("AZURE_CLIENT_ID", "YOUR_CLIENT_ID"),
    "redirect_url": "https://127.0.0.1/auth-response",
    "version": "fabric-loader-0.14.18-1.19",
}

print("[VOYAGER] Initializing...")
voyager = Voyager(
    azure_login=azure_login,
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
      this.executeTask(agentType, command, statusCallback);
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

function routeToAgent(message) {
  const lowerMsg = message.toLowerCase();

  for (const [agentType, agent] of Object.entries(agents)) {
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
  const app = await Spectrum({
    providers: [imessage.config({ local: true })],
  });

  console.log("✅ Connected!\n");

  console.log("💬 Monitoring group chats for commands\n");
  console.log("📝 Example commands to try in a GROUP CHAT:");
  console.log("   • 'mine iron ore'");
  console.log("   • 'build a shelter'");
  console.log("   • 'plan a survival strategy'");
  console.log("   • 'build a base' (triggers multi-agent collaboration)\n");
  console.log("👁️  Listening for messages...\n");

  const seenMessages = new Set();

  for await (const [space, message] of app.messages) {
    try {
      // Skip duplicates
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);

      // Skip own messages
      if (message.sender.id === MY_NUMBER || message.sender.id === "") {
        continue;
      }

      // ONLY process group chats
      const isGroupChat =
        space.id.includes(";+;") || space.id.includes("group");

      if (!isGroupChat) {
        continue; // Ignore DMs
      }

      // Only process text messages
      if (message.content.type !== "text") continue;

      const content = message.content.text || "";
      const sender = message.sender.name || message.sender.id;

      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📨 [${sender}]: ${content}`);

      // Helper to send messages back to group
      const sendToGroup = async (text) => {
        console.log(`📤 ${text}`);
        await space.send(text);
      };

      // Special commands
      if (content.toLowerCase().includes("inventory") || 
          content.toLowerCase().includes("status")) {
        if (SIMULATION_MODE) {
          const inventory = voyager.getInventoryStatus();
          const statusMsg = inventory
            ? `📦 Current Inventory: ${inventory}`
            : `📦 Inventory is empty`;
          await sendToGroup(statusMsg);
        } else {
          await sendToGroup("📦 Status check not available in real mode yet");
        }
        continue;
      }

      // Route to agent
      const routing = routeToAgent(content);

      if (routing) {
        const { agentType, agent } = routing;

        // Execute task via Voyager
        if (SIMULATION_MODE) {
          // Simulation mode
          const result = await voyager.executeTask(agentType, content);
          const response = result.success
            ? `${agent.emoji} ${agent.name}: ${result.result}`
            : `${agent.emoji} ${agent.name}: ❌ ${result.error}`;
          await sendToGroup(response);
        } else {
          // Real Voyager mode
          try {
            await sendToGroup(`${agent.emoji} ${agent.name}: Starting task...`);
            
            const queuePos = voyager.queueTask(agentType, content, async (status) => {
              await sendToGroup(status);
            });
            
            if (queuePos > 0) {
              await sendToGroup(`${agent.emoji} Task queued (position: ${queuePos})`);
            }
          } catch (error) {
            await sendToGroup(`${agent.emoji} ${agent.name}: ❌ Error: ${error.message}`);
          }
        }

        // Check for multi-agent collaboration
        if (SIMULATION_MODE && needsCollaboration(content)) {
          console.log(`🤝 Triggering collaborative response...`);

          await new Promise((resolve) => setTimeout(resolve, 1500));

          await sendToGroup(
            "🧠 Planner: Complex task detected. I'll coordinate Builder and Miner."
          );

          await new Promise((resolve) => setTimeout(resolve, 1000));

          await sendToGroup("⛏️ Miner: Ready to gather resources!");

          await new Promise((resolve) => setTimeout(resolve, 1000));

          await sendToGroup(
            "🏗️ Builder: Standing by for construction once materials arrive."
          );
        }
      } else {
        // No agent matched - general response
        const helpMsg =
          "🤖 Available agents:\n" +
          "🧠 Planner - strategy, planning\n" +
          "🏗️ Builder - building, crafting\n" +
          "⛏️ Miner - mining, gathering\n" +
          "\nTry: 'mine iron ore' or 'build shelter'";

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
