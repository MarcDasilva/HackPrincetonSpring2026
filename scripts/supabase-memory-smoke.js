#!/usr/bin/env node

process.env.PHOTON_NO_MAIN = "1";

const { sharedMemoryStore } = await import("../index.js");

function toCode(value) {
  return `\`${value}\``;
}

async function main() {
  if (!sharedMemoryStore.enabled) {
    console.log("SKIP: Supabase memory is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
    return;
  }

  const stamp = Date.now();
  const marker = `home-smoke-${String(stamp).slice(-6)}`;
  const coordinates = {
    x: 120 + (stamp % 17),
    y: 64,
    z: -240 - (stamp % 23),
  };
  const memoryText = `${marker} chest is at x=${coordinates.x}, y=${coordinates.y}, z=${coordinates.z}.`;
  const spaceId = `smoke-space-${String(stamp).slice(-4)}`;
  const senderId = "smoke-user";

  console.log(`Writing explicit memory for ${toCode(marker)}...`);
  const logged = await sharedMemoryStore.logExplicitMemory({
    text: memoryText,
    spaceId,
    senderId,
    source: "memory-smoke-test",
  });

  if (!logged?.text) {
    throw new Error("Explicit memory write did not return confirmation.");
  }

  console.log("Running semantic memory lookup...");
  const memoryContext = await sharedMemoryStore.retrieveRelevantMemories({
    query: `grab the chest from ${marker}`,
    spaceId,
    senderId,
    limit: 6,
  });

  const resolvedLocation = (memoryContext?.resolved_locations || []).find(
    (location) => location?.mention?.includes(marker) || location?.text?.includes(marker)
  );
  if (!resolvedLocation?.coordinates) {
    throw new Error(
      `Memory lookup did not resolve coordinates for ${marker}. Got: ${JSON.stringify(memoryContext)}`
    );
  }

  const enriched = await sharedMemoryStore.buildTaskWithMemoryContext({
    task: `grab the chest from ${marker}`,
    globalTask: `grab the chest from ${marker}`,
    spaceId,
    senderId,
  });

  const enrichedTask = `${enriched?.task || ""}`;
  const coordToken = `x=${coordinates.x}`;
  if (!enrichedTask.includes("[memory:") || !enrichedTask.includes(coordToken)) {
    throw new Error(`Task enrichment missing expected coordinates. Task: ${enrichedTask}`);
  }

  console.log("PASS: Supabase memory MCP smoke test succeeded.");
  console.log(`Resolved coordinates: x=${resolvedLocation.coordinates.x}, y=${resolvedLocation.coordinates.y}, z=${resolvedLocation.coordinates.z}`);
  console.log(`Vector RPC used: ${Boolean(memoryContext?.debug?.vector_rpc_used)}`);
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
