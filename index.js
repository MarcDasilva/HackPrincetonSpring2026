/**
 * iMessage Integration with Photon Spectrum
 * 
 * This is a basic iMessage bot that receives and responds to messages
 * using Photon's Spectrum framework.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";

function getPhotonCredentials() {
  const projectId = process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID;
  const projectSecret =
    process.env.PHOTON_PROJECT_SECRET ||
    process.env.PROJECT_SECRET ||
    process.env.SECRET_KEY;

  return {
    projectId,
    projectSecret,
    enabled: Boolean(projectId && projectSecret),
  };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENCLAW_COMMAND = process.env.OPENCLAW_COMMAND;
const MINECRAFT_AGENT_BOILERPLATE = [
  "I can help deploy Minecraft agents.",
  "Try a request like:",
  "\"Start 2 Minecraft agents: one miner to gather iron and one builder to make a shelter.\"",
].join("\n");

async function parseIntentForOpenClaw({
  text,
  senderId,
  spaceId,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for LLM intent parsing.");
  }

  const systemPrompt = [
    "You are an intent parser for an iMessage-triggered AI agent orchestrator.",
    "Analyze the incoming user message and decide whether it is asking to start or delegate work to one or more AI agents.",
    "Return JSON only. Do not wrap in markdown. Do not add commentary.",
    "The JSON schema is:",
    "{",
    '  "start_agent_orchestration": boolean,',
    '  "intent": string,',
    '  "task": string | null,',
    '  "agent_count": number,',
    '  "agent_roles": string[],',
    '  "priority": "low" | "normal" | "high",',
    '  "requires_clarification": boolean,',
    '  "clarification_question": string | null,',
    '  "reasoning_summary": string,',
    '  "handoff": {',
    '    "target": "openclaw",',
    '    "mode": "orchestrate" | "ignore",',
    '    "task": string | null,',
    '    "constraints": string[],',
    '    "requested_agent_count": number,',
    '    "source": {',
    '      "platform": "iMessage",',
    '      "sender_id": string,',
    '      "space_id": string',
    "    }",
    "  }",
    "}",
    "Set start_agent_orchestration to true only when the message is actually asking an AI system to do work.",
    "If the message is casual chat, set mode to ignore, task to null, and requested_agent_count to 0.",
    "Infer a reasonable agent_count. Use 1 for straightforward tasks and more than 1 only when coordination is genuinely useful.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            platform: "iMessage",
            sender_id: senderId,
            space_id: spaceId,
            message_text: text,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response did not include message content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`OpenAI returned invalid JSON: ${content}`);
  }

  return parsed;
}

async function handoffToOpenClaw(payload) {
  const serialized = JSON.stringify(payload, null, 2);

  if (!OPENCLAW_COMMAND) {
    console.log("📝 OPENCLAW_COMMAND not set. Handoff payload:");
    console.log(serialized);
    return { delivered: false, mode: "log-only" };
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_COMMAND, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ delivered: true, mode: "process", stdout: stdout.trim() });
      } else {
        reject(
          new Error(
            `OpenClaw process exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        );
      }
    });

    child.stdin.write(serialized);
    child.stdin.end();
  });
}

function formatOrchestrationConfirmation(orchestration, handoffResult) {
  const roles =
    Array.isArray(orchestration.agent_roles) && orchestration.agent_roles.length > 0
      ? orchestration.agent_roles.join(", ")
      : "generalist";

  const deliveryText = handoffResult.delivered
    ? "OpenClaw handoff started."
    : "OpenClaw handoff payload prepared and logged.";

  const clarificationLine = orchestration.requires_clarification
    ? `Clarification needed: ${orchestration.clarification_question || "Please confirm the task details."}`
    : "Clarification needed: no";

  return [
    "Plan confirmed.",
    `Intent: ${orchestration.intent || "start_ai_agents"}`,
    `Task: ${orchestration.task || "unspecified"}`,
    `Agents: ${orchestration.agent_count || 1}`,
    `Roles: ${roles}`,
    `Priority: ${orchestration.priority || "normal"}`,
    clarificationLine,
    `Summary: ${orchestration.reasoning_summary || "Agent orchestration requested."}`,
    deliveryText,
  ].join("\n");
}

async function main() {
  console.log("🚀 Starting iMessage bot with Spectrum...");
  
  // Initialize Spectrum with iMessage provider
  // Local mode works on a Mac you control. Cloud mode unlocks group creation and replies.
  const photon = getPhotonCredentials();
  const app = await Spectrum(
    photon.enabled
      ? {
          projectId: photon.projectId,
          projectSecret: photon.projectSecret,
          providers: [imessage.config()],
        }
      : {
          providers: [imessage.config({ local: true })],
        }
  );

  console.log(
    photon.enabled
      ? "✅ Connected with Photon cloud! Listening for messages...\n"
      : "✅ Connected in local iMessage mode! Listening for messages...\n"
  );
  console.log(`🤖 OpenAI intent parser model: ${OPENAI_MODEL}`);
  console.log(
    OPENCLAW_COMMAND
      ? `🔀 OpenClaw handoff command configured: ${OPENCLAW_COMMAND}\n`
      : "🔀 OpenClaw handoff command not configured. Handoffs will be logged only.\n"
  );

  // Track seen messages to avoid duplicates
  const seenMessages = new Set();
  
  // Your phone number - update this to match YOUR actual number
  const myNumber = process.env.IMESSAGE_BOT_ID || "+19054629158"; // ← CHANGE THIS TO YOUR NUMBER!

  // Main message loop
  for await (const [space, message] of app.messages) {
    // Skip duplicate messages
    if (seenMessages.has(message.id)) {
      continue;
    }
    seenMessages.add(message.id);
    
    // IMPORTANT: Only respond to DMs in this example.
    if (message.platform === "iMessage" && imessage(space).type === "group") {
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
        const text = message.content.text.trim();
        console.log(`   Text: "${text}"`);

        const orchestration = await parseIntentForOpenClaw({
          text,
          senderId: message.sender.id,
          spaceId: space.id,
        });

        console.log("   Parsed orchestration:");
        console.log(JSON.stringify(orchestration, null, 2));

        if (!orchestration.start_agent_orchestration) {
          await space.send(MINECRAFT_AGENT_BOILERPLATE);
          break;
        }

        const handoffResult = await handoffToOpenClaw(orchestration);
        await space.send(formatOrchestrationConfirmation(orchestration, handoffResult));
        
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
