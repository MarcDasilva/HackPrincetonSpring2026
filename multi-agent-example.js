/**
 * Advanced iMessage Bot - Multi-Agent Example
 * 
 * This demonstrates a more sophisticated setup with:
 * - Multiple agent personalities
 * - Command routing
 * - State management
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Agent personalities
const agents = {
  planner: {
    name: "🧠 Planner",
    respond: (message) => {
      return `[Planner]: I'll help coordinate the task. Breaking it down into steps...`;
    }
  },
  builder: {
    name: "🔨 Builder",
    respond: (message) => {
      return `[Builder]: I can help build that! Let me check the requirements...`;
    }
  },
  miner: {
    name: "⛏️ Miner",
    respond: (message) => {
      return `[Miner]: I'll gather the necessary resources for this task.`;
    }
  }
};

// Parse commands from messages
function parseCommand(text) {
  const lowerText = text.toLowerCase();
  
  if (lowerText.includes("plan") || lowerText.includes("organize")) {
    return { agent: "planner", command: text };
  } else if (lowerText.includes("build") || lowerText.includes("create")) {
    return { agent: "builder", command: text };
  } else if (lowerText.includes("mine") || lowerText.includes("gather") || lowerText.includes("collect")) {
    return { agent: "miner", command: text };
  } else if (lowerText.includes("help") || lowerText.includes("?")) {
    return { agent: "help", command: text };
  }
  
  return { agent: "all", command: text };
}

async function main() {
  console.log("🤖 Starting Multi-Agent iMessage Bot...\n");
  
  const app = await Spectrum({
    providers: [
      imessage.config({ local: true }),
    ],
  });

  console.log("✅ Connected! Available agents:");
  console.log("   🧠 Planner - Task planning and coordination");
  console.log("   🔨 Builder - Construction and creation");
  console.log("   ⛏️ Miner - Resource gathering");
  console.log("\nListening for messages...\n");

  for await (const [space, message] of app.messages) {
    // IMPORTANT: Skip your own messages to avoid infinite loops!
    const myNumber = "+19054629158"; // Change this to your actual number if different
    
    if (message.sender.id === myNumber || message.sender.id === "") {
      continue; // Skip bot's own messages
    }
    
    if (message.content.type !== "text") continue;
    
    const text = message.content.text;
    const { agent, command } = parseCommand(text);
    
    console.log(`📨 From: ${message.sender.id}`);
    console.log(`   Message: "${text}"`);
    console.log(`   Routing to: ${agent}\n`);
    
    // Handle help command
    if (agent === "help") {
      await space.send(
        "🤖 Multi-Agent Bot Commands:\n\n" +
        "• Send 'plan [task]' to talk to the Planner\n" +
        "• Send 'build [item]' to talk to the Builder\n" +
        "• Send 'mine [resource]' to talk to the Miner\n" +
        "• Send 'help' for this message\n\n" +
        "Example: 'plan a survival base'"
      );
      continue;
    }
    
    // Route to specific agent
    if (agent !== "all" && agents[agent]) {
      const response = agents[agent].respond(command);
      await space.send(response);
    } else {
      // All agents respond
      await space.send(
        "🤖 All agents standing by! Ask me to:\n" +
        "• Plan something\n" +
        "• Build something\n" +
        "• Mine/gather resources\n" +
        "Or type 'help' for more info"
      );
    }
  }
}

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down multi-agent bot...");
  process.exit(0);
});

main().catch(console.error);
