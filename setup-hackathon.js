#!/usr/bin/env node
/**
 * 🚀 Hackathon Setup Script
 * 
 * Verifies everything is ready for the REAL demo:
 * - OpenAI API key
 * - Voyager installation
 * - Python environment
 * - iMessage permissions
 * 
 * Run: npm run hackathon
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

console.log(`
${BOLD}${CYAN}╔════════════════════════════════════════════════╗
║                                                ║
║     🚀 HACKATHON SETUP - REAL IMPLEMENTATION   ║
║                                                ║
╚════════════════════════════════════════════════╝${RESET}
`);

// ============================================================================
// STEP 1: Check OpenAI API Key
// ============================================================================

console.log(`${BOLD}${BLUE}[1/5] Checking OpenAI API Key...${RESET}`);

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || apiKey === "YOUR_API_KEY_HERE") {
  console.log(`${RED}❌ OpenAI API key not found!${RESET}

${YELLOW}To get your key:${RESET}
1. Go to: ${CYAN}https://platform.openai.com/api-keys${RESET}
2. Click "Create new secret key"
3. Copy the key (starts with "sk-...")
4. Run in terminal:

   ${GREEN}export OPENAI_API_KEY="sk-your-actual-key-here"${RESET}

${YELLOW}Or create a .env file:${RESET}
   ${GREEN}echo 'OPENAI_API_KEY=sk-your-key' > .env${RESET}

${YELLOW}Then run again:${RESET}
   ${GREEN}npm run hackathon${RESET}
`);
  process.exit(1);
} else {
  const maskedKey = apiKey.substring(0, 7) + "..." + apiKey.substring(apiKey.length - 4);
  console.log(`${GREEN}✅ OpenAI API key found: ${maskedKey}${RESET}\n`);
}

// ============================================================================
// STEP 2: Check Voyager Path
// ============================================================================

console.log(`${BOLD}${BLUE}[2/5] Checking Voyager Installation...${RESET}`);

const voyagerPath = process.env.VOYAGER_PATH || "../voyager-repo";
const fullPath = path.resolve(process.cwd(), voyagerPath);

if (!fs.existsSync(fullPath)) {
  console.log(`${RED}❌ Voyager repo not found at: ${fullPath}${RESET}

${YELLOW}To fix:${RESET}
1. Clone the repo:
   ${GREEN}git clone -b voyager https://github.com/MarcDasilva/HackPrincetonSpring2026 voyager-repo${RESET}

2. Install dependencies:
   ${GREEN}cd voyager-repo && pip3 install -r requirements.txt${RESET}

3. Set the path:
   ${GREEN}export VOYAGER_PATH="${fullPath}"${RESET}
`);
  process.exit(1);
} else {
  console.log(`${GREEN}✅ Voyager repo found at: ${fullPath}${RESET}\n`);
}

// ============================================================================
// STEP 3: Test Voyager Import
// ============================================================================

console.log(`${BOLD}${BLUE}[3/5] Testing Voyager Import...${RESET}`);

const testImport = spawn("python3", [
  "-c",
  "from voyager import Voyager; print('SUCCESS')",
], {
  cwd: fullPath,
  env: { ...process.env },
});

testImport.stdout.on("data", (data) => {
  if (data.toString().includes("SUCCESS")) {
    console.log(`${GREEN}✅ Voyager imports successfully!${RESET}\n`);
  }
});

let importError = "";
testImport.stderr.on("data", (data) => {
  importError += data.toString();
});

await new Promise((resolve) => {
  testImport.on("close", (code) => {
    if (code !== 0) {
      console.log(`${RED}❌ Voyager import failed!${RESET}

${YELLOW}Error:${RESET}
${importError}

${YELLOW}To fix:${RESET}
   ${GREEN}cd ${fullPath}${RESET}
   ${GREEN}pip3 install -r requirements.txt${RESET}
   ${GREEN}pip3 install langchain_community${RESET}
`);
      process.exit(1);
    }
    resolve();
  });
});

// ============================================================================
// STEP 4: Check iMessage Database
// ============================================================================

console.log(`${BOLD}${BLUE}[4/5] Checking iMessage Permissions...${RESET}`);

const iMessageDB = path.join(
  process.env.HOME,
  "Library",
  "Messages",
  "chat.db"
);

if (!fs.existsSync(iMessageDB)) {
  console.log(`${RED}❌ iMessage database not found!${RESET}

${YELLOW}This might mean:${RESET}
- You haven't used Messages app yet
- Database is in a different location

${YELLOW}Try:${RESET}
1. Open Messages app
2. Send yourself a test message
3. Run this script again
`);
  process.exit(1);
}

try {
  fs.accessSync(iMessageDB, fs.constants.R_OK);
  console.log(`${GREEN}✅ iMessage database accessible!${RESET}\n`);
} catch (error) {
  console.log(`${YELLOW}⚠️  iMessage database found but not readable${RESET}

${YELLOW}To fix:${RESET}
1. Open System Settings
2. Go to Privacy & Security → Full Disk Access
3. Enable for Terminal (or your editor)
4. Restart Terminal
5. Run this script again
`);
}

// ============================================================================
// STEP 5: Configuration Summary
// ============================================================================

console.log(`${BOLD}${BLUE}[5/5] Configuration Summary${RESET}

${BOLD}OpenAI API Key:${RESET} ${GREEN}✓ Set${RESET}
${BOLD}Voyager Path:${RESET}   ${GREEN}${fullPath}${RESET}
${BOLD}iMessage DB:${RESET}    ${GREEN}${iMessageDB}${RESET}
${BOLD}Your Number:${RESET}    ${CYAN}+19054629158${RESET}
`);

// ============================================================================
// READY TO RUN
// ============================================================================

console.log(`
${BOLD}${GREEN}╔════════════════════════════════════════════════╗
║                                                ║
║           ✅ READY FOR HACKATHON! ✅            ║
║                                                ║
╚════════════════════════════════════════════════╝${RESET}

${BOLD}To start the REAL implementation:${RESET}

1. ${YELLOW}Edit the config (optional):${RESET}
   Open: ${CYAN}imessage-voyager-integration.js${RESET}
   Change line 35: ${GREEN}const SIMULATION_MODE = false;${RESET}

2. ${YELLOW}Start the bot:${RESET}
   ${GREEN}npm run voyager${RESET}

3. ${YELLOW}Send a test message to yourself:${RESET}
   Text ${CYAN}+19054629158${RESET} (your number)
   Example: ${BLUE}"mine iron ore"${RESET}

4. ${YELLOW}Watch the magic happen! ✨${RESET}
   You'll get responses from AI agents

${BOLD}${CYAN}Available Commands:${RESET}
${BLUE}Planning:${RESET} "plan a house", "what should I do?"
${BLUE}Building:${RESET} "build a house", "construct a bridge"
${BLUE}Mining:${RESET}   "mine diamonds", "gather wood"

${BOLD}${YELLOW}💰 Cost Warning:${RESET}
Each command costs ~$0.01-0.05 with GPT-4
Budget ~$5-10 for full demo session

${BOLD}${YELLOW}🎯 For Your Demo:${RESET}
See ${CYAN}HACKATHON_SETUP.md${RESET} for:
- Demo script for judges
- Architecture diagram
- Troubleshooting tips
- Backup plan if API fails

${BOLD}Good luck at HackPrinceton! 🎉${RESET}
`);

console.log(`${YELLOW}Starting in 5 seconds...${RESET} (Press Ctrl+C to cancel)\n`);

await new Promise((resolve) => setTimeout(resolve, 5000));

// ============================================================================
// AUTO-START
// ============================================================================

console.log(`${BOLD}${GREEN}🚀 Starting iMessage → Voyager Bridge...${RESET}\n`);

const mainProcess = spawn("node", ["imessage-voyager-integration.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    OPENAI_API_KEY: apiKey,
    VOYAGER_PATH: fullPath,
  },
});

mainProcess.on("close", (code) => {
  if (code !== 0) {
    console.log(`${RED}Process exited with code ${code}${RESET}`);
    process.exit(code);
  }
});

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log(`\n${YELLOW}Stopping...${RESET}`);
  mainProcess.kill("SIGINT");
  process.exit(0);
});
