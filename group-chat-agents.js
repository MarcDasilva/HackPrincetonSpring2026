/**
 * Multi-Agent Group Chat Bot
 * 
 * This creates a system where multiple AI agents respond in a group chat
 * Each agent has its own personality and responds based on keywords
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Define our AI agents with personalities
const agents = {
  planner: {
    name: "🧠 Planner",
    emoji: "🧠",
    keywords: ["plan", "strategy", "organize", "coordinate", "schedule", "what should"],
    respond: (message) => {
      return `🧠 **Planner**: I'll help coordinate this task. Let me break it down:\n` +
             `1. Assess the requirements\n` +
             `2. Allocate resources\n` +
             `3. Set priorities\n` +
             `What's the timeline for: "${message}"?`;
    }
  },
  
  builder: {
    name: "🔨 Builder",
    emoji: "🔨",
    keywords: ["build", "create", "make", "construct", "craft", "design"],
    respond: (message) => {
      return `🔨 **Builder**: I'll handle the construction!\n` +
             `• Checking materials needed\n` +
             `• Preparing the build site\n` +
             `• Ready to start when you are\n` +
             `Building: "${message}"`;
    }
  },
  
  miner: {
    name: "⛏️ Miner",
    emoji: "⛏️",
    keywords: ["mine", "gather", "collect", "find", "get", "resource"],
    respond: (message) => {
      return `⛏️ **Miner**: On it! I'll gather what we need.\n` +
             `• Scanning for resources\n` +
             `• Identifying optimal locations\n` +
             `• Beginning collection\n` +
             `Target: "${message}"`;
    }
  }
};

// Route messages to the appropriate agent
function routeToAgent(text) {
  const lowerText = text.toLowerCase();
  
  // Check each agent's keywords
  for (const [agentName, agent] of Object.entries(agents)) {
    if (agent.keywords.some(keyword => lowerText.includes(keyword))) {
      return { agent: agentName, handler: agent };
    }
  }
  
  // Default: route to planner if no specific match
  return { agent: "planner", handler: agents.planner };
}

async function main() {
  console.log("🤖 Starting Multi-Agent Group Chat Bot...\n");
  
  const app = await Spectrum({
    providers: [
      imessage.config({ local: true }),
    ],
  });

  console.log("✅ Connected! Multi-agent system ready.");
  console.log("\n👥 Available Agents:");
  console.log("   🧠 Planner  - Task planning and coordination");
  console.log("   🔨 Builder  - Construction and creation");
  console.log("   ⛏️  Miner   - Resource gathering");
  console.log("\n📱 The agents will respond in your group chats!");
  console.log("   Send commands like:");
  console.log("   • 'plan a survival base'");
  console.log("   • 'build a house'");
  console.log("   • 'mine some iron'");
  console.log("\n🎯 Listening for messages...\n");

  // Track seen messages
  const seenMessages = new Set();
  const myNumber = "+19054629158"; // Your number

  for await (const [space, message] of app.messages) {
    // Skip duplicates
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    
    // Skip your own messages
    if (message.sender.id === myNumber || message.sender.id === "") continue;
    
    // Only process text messages
    if (message.content.type !== "text") continue;
    
    const text = message.content.text;
    
    // Check for help command
    if (text.toLowerCase().includes("help") || text.toLowerCase() === "?") {
      await space.send(
        "🤖 **Multi-Agent System**\n\n" +
        "Available agents:\n" +
        "• 🧠 Planner - Keywords: plan, organize, strategy\n" +
        "• 🔨 Builder - Keywords: build, create, make\n" +
        "• ⛏️ Miner - Keywords: mine, gather, collect\n\n" +
        "Examples:\n" +
        "• 'plan a base near water'\n" +
        "• 'build a shelter'\n" +
        "• 'mine iron ore'\n\n" +
        "All agents will collaborate on your tasks!"
      );
      continue;
    }
    
    // Route to appropriate agent
    const { agent, handler } = routeToAgent(text);
    
    console.log(`📨 From: ${message.sender.id}`);
    console.log(`   Message: "${text}"`);
    console.log(`   → Routing to: ${handler.name}\n`);
    
    // Get agent response
    const response = handler.respond(text);
    
    // Send response from the agent
    await space.send(response);
    
    // Optional: Have other agents chime in for complex tasks
    if (text.toLowerCase().includes("base") || text.toLowerCase().includes("survival")) {
      // Multiple agents collaborate
      setTimeout(async () => {
        if (agent !== "builder") {
          await space.send(
            `🔨 **Builder**: I can help with that too! I'll prepare the foundation.`
          );
        }
      }, 2000);
      
      setTimeout(async () => {
        if (agent !== "miner") {
          await space.send(
            `⛏️ **Miner**: I'll gather the materials we need!`
          );
        }
      }, 4000);
    }
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down multi-agent system...");
  process.exit(0);
});

main().catch(console.error);
