/**
 * Multi-Agent Minecraft Controller via iMessage
 * 
 * This integrates:
 * - iMessage (via Spectrum)
 * - Multi-agent system (Planner, Builder, Miner)
 * - Minecraft bot (via Mineflayer)
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import MinecraftBot from "./minecraft-bot.js";

// ============================================================================
// AGENT SYSTEM
// ============================================================================

class PlannerAgent {
  async process(command, minecraftBot) {
    console.log("🧠 [Planner] Processing:", command);
    
    // Break down high-level goals
    if (command.includes("survive") || command.includes("night")) {
      return {
        message: "🧠 [Planner]: I'll coordinate a survival plan:\n" +
                 "1. Builder will create shelter\n" +
                 "2. Miner will gather resources\n" +
                 "3. I'll monitor progress",
        actions: ["build shelter", "mine wood"]
      };
    } else if (command.includes("base")) {
      return {
        message: "🧠 [Planner]: Planning base construction:\n" +
                 "• Finding suitable location\n" +
                 "• Coordinating resource gathering\n" +
                 "• Designing layout",
        actions: ["scout location", "gather materials"]
      };
    } else {
      return {
        message: "🧠 [Planner]: Analyzing your request and creating a strategy...",
        actions: []
      };
    }
  }
}

class BuilderAgent {
  async process(command, minecraftBot) {
    console.log("🔨 [Builder] Processing:", command);
    
    if (command.includes("house") || command.includes("shelter")) {
      const result = await minecraftBot.build("shelter");
      return {
        message: "🔨 [Builder]: Starting shelter construction!\n" +
                 "• Placing foundation\n" +
                 "• Building walls\n" +
                 "• Adding roof",
        actions: ["build"]
      };
    } else if (command.includes("wall") || command.includes("fence")) {
      return {
        message: "🔨 [Builder]: Building protective walls around base...",
        actions: ["build wall"]
      };
    } else {
      return {
        message: "🔨 [Builder]: Ready to build! What should I construct?",
        actions: []
      };
    }
  }
}

class MinerAgent {
  async process(command, minecraftBot) {
    console.log("⛏️ [Miner] Processing:", command);
    
    if (command.includes("wood") || command.includes("tree")) {
      try {
        const result = await minecraftBot.mine("oak_log", 10);
        return {
          message: "⛏️ [Miner]: Gathering wood from nearby trees...\n" +
                   result,
          actions: ["mine wood"]
        };
      } catch (err) {
        return {
          message: "⛏️ [Miner]: Looking for trees to chop...",
          actions: ["find wood"]
        };
      }
    } else if (command.includes("stone")) {
      return {
        message: "⛏️ [Miner]: Mining stone for construction materials...",
        actions: ["mine stone"]
      };
    } else if (command.includes("iron")) {
      return {
        message: "⛏️ [Miner]: Searching for iron ore deposits...",
        actions: ["mine iron"]
      };
    } else {
      return {
        message: "⛏️ [Miner]: Ready to gather resources! What do you need?",
        actions: []
      };
    }
  }
}

// ============================================================================
// COMMAND ROUTER
// ============================================================================

class AgentCoordinator {
  constructor(minecraftBot) {
    this.minecraft = minecraftBot;
    this.agents = {
      planner: new PlannerAgent(),
      builder: new BuilderAgent(),
      miner: new MinerAgent(),
    };
  }

  /**
   * Route command to appropriate agent(s)
   */
  async route(command) {
    const lowerCommand = command.toLowerCase();
    const responses = [];

    // Determine which agents should respond
    if (lowerCommand.includes("plan") || lowerCommand.includes("survive") || 
        lowerCommand.includes("strategy")) {
      const result = await this.agents.planner.process(lowerCommand, this.minecraft);
      responses.push(result.message);
    }
    
    if (lowerCommand.includes("build") || lowerCommand.includes("construct") || 
        lowerCommand.includes("house") || lowerCommand.includes("shelter")) {
      const result = await this.agents.builder.process(lowerCommand, this.minecraft);
      responses.push(result.message);
    }
    
    if (lowerCommand.includes("mine") || lowerCommand.includes("gather") || 
        lowerCommand.includes("wood") || lowerCommand.includes("stone") || 
        lowerCommand.includes("iron") || lowerCommand.includes("collect")) {
      const result = await this.agents.miner.process(lowerCommand, this.minecraft);
      responses.push(result.message);
    }

    // If no specific agent matched, show help
    if (responses.length === 0) {
      responses.push(
        "🤖 Multi-Agent System Ready!\n\n" +
        "Available commands:\n" +
        "• 'plan [task]' - Strategic planning\n" +
        "• 'build [structure]' - Construction tasks\n" +
        "• 'mine [resource]' - Resource gathering\n" +
        "• 'status' - Check bot status\n\n" +
        "Example: 'plan survival for the night'"
      );
    }

    return responses;
  }
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

async function main() {
  console.log("🎮 Starting Minecraft Multi-Agent System...\n");

  // Initialize Minecraft bot
  const minecraftBot = new MinecraftBot();
  
  // Connect to Minecraft server (adjust these settings!)
  try {
    await minecraftBot.connect({
      host: 'localhost',        // Change to your server IP
      port: 25565,              // Change to your server port
      username: 'SpectrumBot',  // Bot's username
      // version: '1.20.1',     // Uncomment and set your Minecraft version
    });
  } catch (err) {
    console.log("⚠️ Couldn't connect to Minecraft server");
    console.log("💡 You can still test the iMessage integration!");
    console.log("   Start a Minecraft server and restart this bot.\n");
  }

  // Initialize agent coordinator
  const coordinator = new AgentCoordinator(minecraftBot);

  // Initialize Spectrum (iMessage)
  const app = await Spectrum({
    providers: [
      imessage.config({ local: true }),
    ],
  });

  console.log("✅ iMessage connected! Listening for commands...\n");

  // Track seen messages
  const seenMessages = new Set();
  const myNumber = "+19054629158"; // Update to your number

  // Main message loop
  for await (const [space, message] of app.messages) {
    // Skip duplicates
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    
    // Skip group chats
    if (message.space.id.includes(";+;")) continue;
    
    // Skip own messages
    if (message.sender.id === myNumber || message.sender.id === "") continue;

    // Only process text messages
    if (message.content.type !== "text") continue;

    const command = message.content.text;
    console.log(`📨 Command from ${message.sender.id}: "${command}"`);

    // Handle special commands
    if (command.toLowerCase() === "status") {
      const status = minecraftBot.getStatus();
      if (status.connected) {
        await space.send(
          `🎮 Minecraft Bot Status:\n` +
          `📍 Position: ${status.position}\n` +
          `❤️ Health: ${status.health}/20\n` +
          `🍖 Food: ${status.food}/20\n` +
          `🌤️ Weather: ${status.weather}`
        );
      } else {
        await space.send("❌ Not connected to Minecraft server");
      }
      continue;
    }

    // Route to agents
    try {
      const responses = await coordinator.route(command);
      
      // Send all agent responses
      for (const response of responses) {
        await space.send(response);
      }
    } catch (err) {
      console.error("Error processing command:", err);
      await space.send("❌ Error executing command: " + err.message);
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log("\n👋 Shutting down...");
  process.exit(0);
});

// Start the application
main().catch(console.error);
