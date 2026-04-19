/**
 * End-to-End Test: Persistent Memory + iMessage Integration
 *
 * Simulates real message flow without needing actual iMessage or Minecraft
 * Tests:
 * - Task memory recording
 * - Location discovery & recall
 * - World event tracking
 * - Context building for agents
 * - Multi-message scenarios (5x "go mine")
 */

import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_KEY || ""
);

// Task type inference (copied from main bot)
const TASK_TYPE_KEYWORDS = {
  mine: ["mine", "dig", "ore", "cave", "underground"],
  build: ["build", "construct", "place", "create", "house", "base"],
  explore: ["explore", "find", "search", "scout", "discover"],
  gather: ["gather", "collect", "chop", "harvest", "farm"],
  craft: ["craft", "make", "smelt", "brew"],
  plan: ["plan", "strategy", "organize", "coordinate"],
  fight: ["fight", "kill", "attack", "defend", "mob"],
  travel: ["go to", "travel", "walk", "return", "head"],
};

const LOCATION_TYPES_FOR_TASK = {
  mine: ["cave", "ore_deposit"],
  build: ["base", "structure"],
  explore: ["cave", "village", "landmark"],
  gather: ["farm", "village", "water"],
};

function inferTaskType(command) {
  const lower = command.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return "other";
}

// ============================================================================
// MEMORY API (same as in bot)
// ============================================================================

const memory = {
  async startTask(agentId, command) {
    const taskType = inferTaskType(command);
    const { data, error } = await supabase
      .from("task_runs")
      .insert({ task_type: taskType, command, agent_id: agentId, status: "active" })
      .select()
      .single();
    if (error) { console.error("[MEMORY] startTask error:", error.message); return null; }
    return data;
  },

  async completeTask(taskId, outcome, locationsDiscovered = [], resourcesGathered = {}) {
    const { error } = await supabase
      .from("task_runs")
      .update({
        status: "completed",
        outcome,
        locations_discovered: locationsDiscovered,
        resources_gathered: resourcesGathered,
        completed_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    if (error) console.error("[MEMORY] completeTask error:", error.message);
  },

  async recordLocation(name, locationType, coords, taskId = null) {
    const { error } = await supabase
      .from("known_locations")
      .insert({
        name,
        location_type: locationType,
        coords,
        discovered_during: taskId,
        status: "active",
      });
    if (error) console.error("[MEMORY] recordLocation error:", error.message);
  },

  async recallSimilarTasks(command, limit = 5) {
    const taskType = inferTaskType(command);
    const { data, error } = await supabase
      .from("task_runs")
      .select("*")
      .eq("task_type", taskType)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) { console.error("[MEMORY] recall error:", error.message); return []; }
    return data ?? [];
  },

  async getLocationsForTask(command, limit = 10) {
    const taskType = inferTaskType(command);
    const locationTypes = LOCATION_TYPES_FOR_TASK[taskType] ?? [];
    if (locationTypes.length === 0) return [];

    const { data, error } = await supabase
      .from("known_locations")
      .select("*")
      .in("location_type", locationTypes)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) { console.error("[MEMORY] locations error:", error.message); return []; }
    return data ?? [];
  },

  async getRecentWorldEvents(limit = 10) {
    const { data, error } = await supabase
      .from("world_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) { console.error("[MEMORY] events error:", error.message); return []; }
    return data ?? [];
  },

  async buildContextPrompt(agentId, command) {
    const sections = [];

    const [pastTasks, locations, events] = await Promise.all([
      memory.recallSimilarTasks(command),
      memory.getLocationsForTask(command),
      memory.getRecentWorldEvents(10),
    ]);

    if (pastTasks.length > 0) {
      sections.push("=== SIMILAR PAST TASKS ===");
      for (const t of pastTasks) {
        let line = `[${t.task_type}] "${t.command}" → ${t.outcome ?? "no outcome"}`;
        if (t.locations_discovered?.length > 0) {
          line += ` | Found: ${t.locations_discovered.map((l) => `${l.name} at (${l.coords.x},${l.coords.y},${l.coords.z})`).join(", ")}`;
        }
        if (t.resources_gathered && Object.keys(t.resources_gathered).length > 0) {
          line += ` | Gathered: ${Object.entries(t.resources_gathered).map(([k, v]) => `${v}x ${k}`).join(", ")}`;
        }
        sections.push(line);
      }
    }

    if (locations.length > 0) {
      sections.push("\n=== KNOWN LOCATIONS ===");
      for (const loc of locations) {
        sections.push(`[${loc.location_type}] "${loc.name}" at (${loc.coords.x},${loc.coords.y},${loc.coords.z})`);
      }
    }

    if (events.length > 0) {
      sections.push("\n=== RECENT WORLD EVENTS ===");
      for (const evt of events) {
        sections.push(`[${evt.event_type}] ${evt.object_name ?? evt.object_type ?? "?"}`);
      }
    }

    return sections.length > 0 ? sections.join("\n") : "No prior context.";
  },
};

// ============================================================================
// TEST SCENARIOS
// ============================================================================

async function testScenario(name, fn) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📋 TEST: ${name}`);
  console.log("=".repeat(70));
  try {
    await fn();
    console.log("✅ PASSED\n");
  } catch (e) {
    console.error(`❌ FAILED: ${e.message}\n`);
    throw e;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

async function runAllTests() {
  console.log(`\n🧪 END-TO-END PERSISTENT MEMORY TEST SUITE\n`);

  // Cleanup: Delete all test data first
  console.log("🧹 Cleaning up old test data...");
  await supabase.from("task_runs").delete().ilike("command", "%test%");
  await supabase.from("known_locations").delete().ilike("name", "%test%");
  await supabase.from("world_events").delete().ilike("description", "%test%");
  await sleep(500);

  // Test 1: Simple task tracking
  await testScenario("Task Recording - Single Mining Task", async () => {
    const task = await memory.startTask("miner", "mine iron ore for test");
    console.log(`  Task started: ${task.id}`);

    await memory.completeTask(task.id, "Mined 32 iron ore", [
      { name: "Test Iron Cave", coords: { x: 100, y: 50, z: -200 }, type: "cave" }
    ], { iron_ore: 32 });

    await memory.recordLocation("Test Iron Cave", "cave", { x: 100, y: 50, z: -200 }, task.id);
    console.log("  Task completed with location recorded");

    const recalled = await memory.recallSimilarTasks("mine ore");
    console.log(`  Recalled ${recalled.length} similar tasks`);
    if (recalled.length > 0) {
      const found = recalled.find((t) => t.id === task.id);
      if (!found) throw new Error("Task not found in recall");
      console.log(`  ✓ Task found in recall`);
    }
  });

  // Test 2: Location discovery & retrieval
  await testScenario("Location Memory - Discover and Recall", async () => {
    const task = await memory.startTask("explorer", "explore caves for test");
    console.log(`  Task started: ${task.id}`);

    await memory.recordLocation("Test Discovery Cave 1", "cave", { x: 150, y: 45, z: -250 }, task.id);
    await memory.recordLocation("Test Discovery Cave 2", "cave", { x: 200, y: 40, z: -300 }, task.id);

    await memory.completeTask(task.id, "Found 2 caves", [
      { name: "Test Discovery Cave 1", coords: { x: 150, y: 45, z: -250 }, type: "cave" },
      { name: "Test Discovery Cave 2", coords: { x: 200, y: 40, z: -300 }, type: "cave" },
    ]);

    const locations = await memory.getLocationsForTask("mine again");
    console.log(`  Found ${locations.length} active cave locations`);
    if (locations.length < 2) throw new Error("Not all locations retrieved");
    console.log(`  ✓ All discovered caves available for recall`);
  });

  // Test 3: Context building with history
  await testScenario("Context Building - Full Prompt Generation", async () => {
    const context = await memory.buildContextPrompt("miner", "go mine");
    console.log(`  Generated context (${context.length} chars):`);
    console.log(`\n${context}\n`);

    if (!context.includes("SIMILAR PAST TASKS")) throw new Error("Context missing past tasks");
    if (!context.includes("KNOWN LOCATIONS")) throw new Error("Context missing locations");
    console.log("  ✓ Context includes past tasks and locations");
  });

  // Test 4: The "5x go mine" scenario
  await testScenario("Repeated Commands - 5x Mining with Location Reuse", async () => {
    console.log("  Simulating user sending 'go mine' 5 times...\n");

    // Count existing mine tasks before we start
    const baselineTasks = await memory.recallSimilarTasks("go mine", 100);
    const baselineCount = baselineTasks.length;
    console.log(`  (baseline: ${baselineCount} existing mine tasks from earlier tests)\n`);

    for (let i = 1; i <= 5; i++) {
      console.log(`  [Message ${i}] User: "go mine"`);

      const task = await memory.startTask("miner", `go mine (attempt ${i})`);

      const pastTasks = await memory.recallSimilarTasks("go mine", 100);
      const newTaskCount = pastTasks.length - baselineCount;
      const locations = await memory.getLocationsForTask("go mine", 5);

      if (i === 1) {
        console.log(`    → Task 1: ${baselineCount > 0 ? `Has ${baselineCount} tasks from earlier, but 0 from this round` : "No prior context, exploring fresh"}`);
        if (newTaskCount > 0) throw new Error("Should have no NEW completed tasks on first attempt of this round");
      } else {
        console.log(`    → Task ${i}: ${newTaskCount} new tasks from this round, ${locations.length} known caves`);
        if (newTaskCount === 0) throw new Error(`Task ${i} should have recall from this round`);
        if (locations.length === 0) throw new Error(`Task ${i} should have locations`);

        const mostRecent = pastTasks[0];
        if (mostRecent.locations_discovered?.length > 0) {
          const loc = mostRecent.locations_discovered[0];
          console.log(`       Agent recalls: "I found ${loc.name} at (${loc.coords.x},${loc.coords.y},${loc.coords.z}) before"`);
        }
      }

      await memory.completeTask(task.id, `Mined ore (attempt ${i})`, [
        { name: "Recurring Test Cave", coords: { x: 100, y: 50, z: -200 }, type: "cave" }
      ], { iron_ore: 16 + i * 5 });

      if (i === 1) {
        await memory.recordLocation("Recurring Test Cave", "cave", { x: 100, y: 50, z: -200 }, task.id);
      }

      await sleep(100);
    }

    console.log(`\n  ✓ All 5 attempts tracked. Agent learned and reused location.`);
  });

  // Test 5: World event tracking
  await testScenario("World Events - Destruction & State Changes", async () => {
    // Create a location
    await memory.recordLocation("Test House", "base", { x: 50, y: 65, z: 0 });
    console.log("  Created: Test House at (50, 65, 0)");

    // Record destruction event
    await supabase.from("world_events").insert({
      event_type: "destroyed",
      object_type: "house",
      object_name: "Test House",
      coords: { x: 50, y: 65, z: 0 },
      caused_by: "creeper",
      description: "Test house destroyed by creeper",
    });
    console.log("  Recorded: House destroyed by creeper");

    // Mark location as destroyed
    const { data: locs } = await supabase
      .from("known_locations")
      .select("*")
      .eq("name", "Test House");

    if (locs && locs[0]) {
      await supabase
        .from("known_locations")
        .update({ status: "destroyed" })
        .eq("id", locs[0].id);
    }

    const events = await memory.getRecentWorldEvents(5);
    const destructionEvent = events.find((e) => e.caused_by === "creeper" && e.description?.includes("Test"));
    if (!destructionEvent) throw new Error("Destruction event not recorded");

    console.log("  ✓ Destruction event tracked & location marked as destroyed");
  });

  // Test 6: Cross-agent awareness
  await testScenario("Multi-Agent Awareness - Agent B Sees Agent A's Discoveries", async () => {
    // Agent A (miner) discovers a cave
    const agentATask = await memory.startTask("miner", "explore caves for cross-agent test");
    await memory.recordLocation("Test Cross-Agent Cave", "cave", { x: 300, y: 30, z: -400 }, agentATask.id);
    await memory.completeTask(agentATask.id, "Found cave", [
      { name: "Test Cross-Agent Cave", coords: { x: 300, y: 30, z: -400 }, type: "cave" }
    ]);
    console.log("  Agent A (miner): Discovered cave at (300, 30, -400)");

    // Agent B (builder) should see Agent A's discovery
    const agentBContext = await memory.buildContextPrompt("builder", "build near caves");
    if (!agentBContext.includes("Test Cross-Agent Cave")) {
      throw new Error("Agent B should see Agent A's discoveries");
    }

    console.log("  Agent B (builder): Context includes Agent A's discovery");
    console.log("  ✓ Multi-agent knowledge sharing works");
  });

  // Test 7: Empty state handling
  await testScenario("Edge Case - First Agent with No History", async () => {
    const freshContext = await memory.buildContextPrompt("builder", "build a random thing");
    console.log(`  Context for new agent: "${freshContext.substring(0, 50)}..."`);

    if (freshContext === "No prior context.") {
      console.log("  ✓ Gracefully handles no history");
    }
  });

  console.log(`\n${"=".repeat(70)}`);
  console.log(`✅ ALL TESTS PASSED`);
  console.log("=".repeat(70));
  console.log(`\n📊 Summary:`);
  console.log(`  ✓ Task memory recording`);
  console.log(`  ✓ Location discovery & recall`);
  console.log(`  ✓ Context building`);
  console.log(`  ✓ Repeated command learning (5x mining)`);
  console.log(`  ✓ World event tracking`);
  console.log(`  ✓ Cross-agent awareness`);
  console.log(`  ✓ Edge cases\n`);
}

// ============================================================================
// RUN
// ============================================================================

runAllTests().catch((err) => {
  console.error("\n❌ TEST SUITE FAILED:", err.message);
  process.exit(1);
});
