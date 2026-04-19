/**
 * Test Script for iMessage Integration
 * 
 * This helps you verify that your setup is working correctly.
 */

import { IMessageSDK } from "@photon-ai/imessage-kit";

async function testLocalConnection() {
  console.log("🧪 Testing local iMessage connection...\n");
  let sdk;

  try {
    sdk = new IMessageSDK();

    // Test 1: List recent chats
    console.log("📋 Test 1: Fetching recent chats...");
    const chats = await sdk.listChats({ limit: 5 });
    console.log(`✅ Found ${chats.length} chats`);
    
    if (chats.length > 0) {
      console.log("\nRecent chats:");
      chats.forEach((chat, i) => {
        console.log(`  ${i + 1}. ${chat.chatId} (${chat.kind})`);
      });
    }
    
    // Test 2: Get recent messages
    console.log("\n📬 Test 2: Fetching recent messages...");
    const messageResult = await sdk.getMessages({ limit: 5 });
    const messages = Array.isArray(messageResult?.messages)
      ? messageResult.messages
      : [];
    console.log(`✅ Found ${messages.length} messages`);

    if (messages.length > 0) {
      console.log("\nRecent messages:");
      messages.forEach((msg, i) => {
        const preview = msg.text?.substring(0, 50) || "[No text]";
        const from = msg.participant || msg.sender || "[Unknown]";
        console.log(`  ${i + 1}. From ${from}: ${preview}`);
      });
    }
    
    await sdk.close();

    console.log("\n✅ All tests passed! Your iMessage setup is working.");
    console.log("You can now run: npm start");
  } catch (error) {
    console.error("\n❌ Test failed:", error.message);
    if (
      /unable to open database file/i.test(error.message) ||
      /chat\.db/i.test(error.message)
    ) {
      console.log("   Messages DB: ~/Library/Messages/chat.db");
    }
    console.log("\n💡 Troubleshooting:");
    console.log("1. Make sure you granted Full Disk Access to your terminal");
    console.log("2. Restart your terminal after granting access");
    console.log("3. Check that iMessage is working normally on your Mac");
    process.exitCode = 1;
  } finally {
    if (sdk) {
      await sdk.close().catch(() => {});
    }
  }
}

testLocalConnection();
