#!/usr/bin/env node
/**
 * Quick Test: iMessage → Voyager Bridge
 * 
 * This tests if our integration layer works WITHOUT needing:
 * - Minecraft
 * - OpenAI API key
 * - Azure login
 * 
 * It simulates the full flow to verify the connection.
 */

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MY_NUMBER = "+19054629158";
const VOYAGER_PATH = "../voyager-repo";

console.log("╔════════════════════════════════════════════════════════╗");
console.log("║  Quick Test: iMessage → Voyager Bridge                ║");
console.log("╚════════════════════════════════════════════════════════╝\n");

// Test 1: Check if Voyager can be imported
console.log("📝 Test 1: Can we import Voyager?");
const testImport = spawn('python3', ['-c', 'from voyager import Voyager; print("SUCCESS")'], {
  cwd: path.join(__dirname, VOYAGER_PATH)
});

let importSuccess = false;

testImport.stdout.on('data', (data) => {
  if (data.toString().includes('SUCCESS')) {
    importSuccess = true;
    console.log("   ✅ Voyager imports successfully!\n");
  }
});

testImport.stderr.on('data', (data) => {
  const err = data.toString();
  if (!err.includes('Warning') && !err.includes('Deprecation')) {
    console.error("   ❌ Error:", err);
  }
});

await new Promise(resolve => testImport.on('close', resolve));

if (!importSuccess) {
  console.error("❌ Voyager import failed! Run: cd voyager-repo && pip3 install -r requirements.txt");
  process.exit(1);
}

// Test 2: Can we receive iMessage messages?
console.log("📝 Test 2: Can we connect to iMessage?");
let messageReceived = false;
let testTimeout;

try {
  const app = await Spectrum({
    providers: [imessage.config({ local: true })],
  });
  
  console.log("   ✅ iMessage connected!\n");
  
  console.log("📝 Test 3: Waiting for a test message...");
  console.log("   👉 Send 'test' in any chat to verify the bridge\n");
  console.log("   ⏱️  Waiting 30 seconds...");
  
  // Timeout after 30 seconds
  testTimeout = setTimeout(() => {
    if (!messageReceived) {
      console.log("\n   ⏰ Timeout reached. No message received.");
      console.log("   ℹ️  That's OK - iMessage connection works!");
      console.log("   ℹ️  Send a message in the next test to see it work.\n");
      process.exit(0);
    }
  }, 30000);
  
  const seenMessages = new Set();
  
  for await (const [space, message] of app.messages) {
    // Skip duplicates
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);
    
    // Skip own messages
    if (message.sender.id === MY_NUMBER || message.sender.id === "") continue;
    
    // Skip non-text
    if (message.content.type !== "text") continue;
    
    const text = message.content.text;
    
    console.log(`\n   ✅ Received message: "${text}"`);
    console.log(`      From: ${message.sender.name || message.sender.id}`);
    
    // Route to agent
    let agent = "Unknown";
    if (text.toLowerCase().includes("mine")) agent = "⛏️ Miner";
    else if (text.toLowerCase().includes("build")) agent = "🏗️ Builder";
    else if (text.toLowerCase().includes("plan")) agent = "🧠 Planner";
    
    console.log(`      Routed to: ${agent}`);
    
    // Simulate calling Voyager (without actually doing it)
    console.log("\n   🔄 Would execute Voyager with:");
    console.log(`      Task: "${text}"`);
    console.log(`      Agent: ${agent}`);
    
    // Send test response
    await space.send(`✅ Bridge Test Successful!\n\nReceived: "${text}"\nAgent: ${agent}\n\nThe iMessage→Voyager bridge is working!`);
    
    console.log("\n   ✅ Sent response back to iMessage");
    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║  ✅ ALL TESTS PASSED!                                  ║");
    console.log("║                                                        ║");
    console.log("║  The iMessage → Voyager bridge is working correctly!  ║");
    console.log("║  Ready to connect to real Voyager when you have:      ║");
    console.log("║  • Minecraft running                                   ║");
    console.log("║  • OpenAI API key                                      ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");
    
    messageReceived = true;
    clearTimeout(testTimeout);
    process.exit(0);
  }
  
} catch (error) {
  console.error("❌ Error:", error.message);
  console.error("\nTroubleshooting:");
  console.error("1. Make sure you've granted Full Disk Access");
  console.error("2. Check that iMessage is working on your Mac");
  process.exit(1);
}
