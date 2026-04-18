#!/usr/bin/env node

/**
 * Quick Start Script
 * Run this to get started quickly!
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";

console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     📱 iMessage Bot with Photon Spectrum                   ║
║                                                            ║
║     Welcome to your iMessage integration!                  ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`);

// Check if we're on macOS
if (process.platform !== "darwin") {
  console.log("❌ ERROR: This bot only works on macOS (for iMessage access)\n");
  process.exit(1);
}

// Check Node.js version
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.slice(1).split(".")[0]);

if (majorVersion < 20) {
  console.log(`❌ ERROR: Node.js >= 20.0.0 required (you have ${nodeVersion})`);
  console.log("\nInstall latest Node.js from: https://nodejs.org/\n");
  process.exit(1);
}

console.log(`✅ Node.js ${nodeVersion} - OK\n`);

// Check if node_modules exists
if (!existsSync("node_modules")) {
  console.log("📦 Installing dependencies...\n");
  try {
    execSync("npm install", { stdio: "inherit" });
    console.log("\n✅ Dependencies installed!\n");
  } catch (error) {
    console.log("❌ Failed to install dependencies");
    console.log("Try running: npm install\n");
    process.exit(1);
  }
}

// Show menu
console.log(`
What would you like to do?

1️⃣  Test connection          → npm test
2️⃣  Run basic bot            → npm start
3️⃣  Run multi-agent demo     → npm run multi-agent
4️⃣  Read setup guide         → cat SETUP.md
5️⃣  Read API reference       → cat API_REFERENCE.md

📚 Documentation:
   • SETUP.md ................. Complete setup guide
   • API_REFERENCE.md ......... Quick API reference
   • ARCHITECTURE.md .......... System architecture
   • TROUBLESHOOTING.md ....... Common errors & fixes
   • SUMMARY.md ............... Project overview

💡 Quick commands:
   npm test ................... Test your setup
   npm start .................. Run the basic bot
   npm run multi-agent ........ Run multi-agent demo
   npm run dev ................ Auto-reload on changes

⚠️  IMPORTANT: Grant Full Disk Access first!
   System Settings → Privacy & Security → Full Disk Access
   → Add your terminal → Restart terminal

🆘 Need help?
   • Check TROUBLESHOOTING.md
   • Join Discord: https://discord.com/invite/4yXmmFPadR
   • Read docs: https://docs.photon.codes/

🚀 Ready to start? Run:  npm test
`);
