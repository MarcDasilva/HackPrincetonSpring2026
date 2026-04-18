/**
 * iMessage Integration with Photon Spectrum
 * 
 * This is a basic iMessage bot that receives and responds to messages
 * using Photon's Spectrum framework.
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

async function main() {
  console.log("🚀 Starting iMessage bot with Spectrum...");
  
  // Initialize Spectrum with iMessage provider
  // Using local mode for testing (no credentials needed)
  // For production, get credentials from https://app.photon.codes/
  const app = await Spectrum({
    // Uncomment these lines when you have credentials:
    // projectId: process.env.PROJECT_ID,
    // projectSecret: process.env.PROJECT_SECRET,
    providers: [
      // Local mode: connects to macOS iMessage database directly
      imessage.config({ local: true }),
      
      // Cloud mode (requires credentials):
      // imessage.config(),
    ],
  });

  console.log("✅ Connected! Listening for messages...\n");

  // Track seen messages to avoid duplicates
  const seenMessages = new Set();
  
  // Your phone number - update this to match YOUR actual number
  const myNumber = "+19054629158"; // ← CHANGE THIS TO YOUR NUMBER!

  // Main message loop
  for await (const [space, message] of app.messages) {
    // Skip duplicate messages
    if (seenMessages.has(message.id)) {
      continue;
    }
    seenMessages.add(message.id);
    
    // IMPORTANT: Only respond to messages sent DIRECTLY TO YOU (DMs only)
    // Skip group chats entirely
    if (message.space.id.includes(";+;") || message.space.id.includes("group")) {
      continue; // Skip group messages
    }
    
    // Skip your own messages to avoid infinite loops
    if (message.sender.id === myNumber || message.sender.id === "") {
      continue;
    }
    
    // Skip messages from other people (only respond to specific numbers if you want)
    // Uncomment these lines if you only want to respond to specific people:
    // const allowedNumbers = ["+14708446231", "+16504459079"]; // Add numbers here
    // if (!allowedNumbers.includes(message.sender.id)) {
    //   continue;
    // }
    
    // Log incoming message
    console.log(`📨 [${message.platform}] From: ${message.sender.id}`);
    
    // Handle different content types
    switch (message.content.type) {
      case "text": {
        const text = message.content.text;
        console.log(`   Text: "${text}"`);
        
        // Send a response back
        await space.send("Got your message! 👍");
        
        break;
      }
      
      case "attachment": {
        const bytes = await message.content.read();
        console.log(`   Attachment: ${message.content.name} (${bytes.length} bytes)`);
        await space.send(`Received your file: ${message.content.name}`);
        break;
      }
      
      case "custom": {
        console.log(`   Custom:`, message.content.raw);
        break;
      }
      
      default:
        console.log(`   Unknown content type: ${message.content.type}`);
    }
    
    console.log(""); // Empty line for readability
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  process.exit(0);
});

// Start the bot
main().catch((error) => {
  console.error("❌ Error:", error);
  process.exit(1);
});
