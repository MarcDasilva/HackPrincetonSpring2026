/**
 * Photon Spectrum Cloud Integration
 * 
 * This version connects to Photon's cloud platform for:
 * - Multi-platform support (iMessage + WhatsApp + Telegram + more)
 * - Cloud dashboard access
 * - Enhanced features (reactions, typing indicators, etc.)
 * 
 * Setup:
 * 1. Sign up at https://photon.codes
 * 2. Create a Spectrum project
 * 3. Get your API key from dashboard
 * 4. Set environment variable: PHOTON_API_KEY=your_key
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// Configuration
const USE_CLOUD_MODE = process.env.PHOTON_API_KEY ? true : false;
const MY_NUMBER = "+19054629158";

// Agent definitions
const agents = {
  planner: {
    name: "🧠 Planner",
    emoji: "🧠",
    keywords: ["plan", "strategy", "organize", "coordinate"],
    respond: (message) => `${agents.planner.emoji} Analyzing task and creating strategy...`
  },
  builder: {
    name: "🏗️ Builder",
    emoji: "🏗️",
    keywords: ["build", "create", "craft", "construct"],
    respond: (message) => `${agents.builder.emoji} Ready to build! Checking materials...`
  },
  miner: {
    name: "⛏️ Miner",
    emoji: "⛏️",
    keywords: ["mine", "dig", "gather", "collect", "find"],
    respond: (message) => `${agents.miner.emoji} Mining resources! Going deep...`
  }
};

function routeToAgent(text) {
  const lowerText = text.toLowerCase();
  
  for (const [agentId, agent] of Object.entries(agents)) {
    for (const keyword of agent.keywords) {
      if (lowerText.includes(keyword)) {
        return { agentId, agent };
      }
    }
  }
  
  return null;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║      Photon Spectrum Multi-Platform Integration         ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  
  if (USE_CLOUD_MODE) {
    console.log("🌩️  Using CLOUD MODE (Photon Platform)");
    console.log("   • Multi-platform support enabled");
    console.log("   • Dashboard: https://photon.codes/dashboard");
    console.log("   • API Key: " + process.env.PHOTON_API_KEY.substring(0, 10) + "...\n");
  } else {
    console.log("🏠 Using LOCAL MODE (iMessage only)");
    console.log("   ℹ️  To enable cloud mode:");
    console.log("   1. Get API key from https://photon.codes");
    console.log("   2. Set: export PHOTON_API_KEY=your_key");
    console.log("   3. Restart this script\n");
  }
  
  // Initialize Spectrum
  const config = USE_CLOUD_MODE 
    ? {
        // Cloud mode - multiple platforms
        apiKey: process.env.PHOTON_API_KEY,
        providers: [
          imessage.config({ mode: "cloud" }),
          // Future: Add more platforms from your Photon dashboard
          // whatsapp.config({ mode: "cloud" }),
          // telegram.config({ mode: "cloud" }),
        ]
      }
    : {
        // Local mode - iMessage only
        providers: [
          imessage.config({ local: true })
        ]
      };
  
  console.log("📱 Connecting to Spectrum...");
  const app = await Spectrum(config);
  console.log("✅ Connected!\n");
  
  console.log("🤖 Active Agents:");
  Object.entries(agents).forEach(([id, agent]) => {
    console.log(`   ${agent.emoji} ${agent.name} - ${agent.keywords.join(", ")}`);
  });
  
  console.log("\n👁️  Monitoring messages across all platforms...\n");
  
  const seenMessages = new Set();
  
  for await (const [space, message] of app.messages) {
    try {
      // Skip duplicates
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      
      // Skip own messages
      if (message.sender.id === MY_NUMBER || message.sender.id === "") continue;
      
      // Skip non-text messages
      if (message.content.type !== "text") continue;
      
      const text = message.content.text;
      const platform = space.platform || "iMessage";
      
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📨 [${platform}] ${message.sender.name || message.sender.id}`);
      console.log(`   "${text}"`);
      
      // Route to agent
      const routing = routeToAgent(text);
      
      if (routing) {
        const { agentId, agent } = routing;
        console.log(`   → Routing to: ${agent.name}`);
        
        // Send response
        const response = agent.respond(text);
        await space.send(response);
        
        console.log(`   ✅ Sent: ${response}`);
        
        // If cloud mode, we could also send reactions
        if (USE_CLOUD_MODE && space.react) {
          await space.react(message, agent.emoji);
          console.log(`   👍 Reacted with ${agent.emoji}`);
        }
        
      } else {
        // No agent matched - send help
        const helpMsg = 
          "🤖 Available agents:\n" +
          "🧠 Planner - plan, organize, strategy\n" +
          "🏗️ Builder - build, create, craft\n" +
          "⛏️ Miner - mine, dig, gather\n\n" +
          "Try: 'mine iron ore' or 'build shelter'";
        
        await space.send(helpMsg);
        console.log(`   ℹ️  Sent help message`);
      }
      
    } catch (error) {
      console.error("❌ Error processing message:", error.message);
    }
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down Photon Spectrum integration...");
  process.exit(0);
});

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  console.error("\nTroubleshooting:");
  console.error("• Check your Photon API key");
  console.error("• Verify Full Disk Access for local mode");
  console.error("• Visit https://photon.codes/docs for help");
  process.exit(1);
});

console.log("\n📋 QUICK START:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("Local Mode (Current):");
console.log("  • iMessage only");
console.log("  • No setup needed");
console.log("");
console.log("Cloud Mode (Upgrade):");
console.log("  1. Go to https://photon.codes");
console.log("  2. Sign up / create project");
console.log("  3. Enable platforms (iMessage, WhatsApp, etc.)");
console.log("  4. Get API key from dashboard");
console.log("  5. export PHOTON_API_KEY=your_key");
console.log("  6. Restart this script");
console.log("");
console.log("Benefits:");
console.log("  ✅ Multiple platforms at once");
console.log("  ✅ Cloud dashboard & analytics");
console.log("  ✅ Reactions, typing indicators");
console.log("  ✅ Better scaling & reliability");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
