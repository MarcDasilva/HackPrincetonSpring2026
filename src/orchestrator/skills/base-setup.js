import { AGENT_IDS } from "../../shared/constants.js";

export const BASE_SETUP_SKILL_ID = "setup_new_base_v1";

export function matchesBaseSetupRequest(text) {
  const lower = String(text || "").toLowerCase();
  const asksForBase = /\b(base|starter house|safe house|shelter)\b/.test(lower);
  const asksToCreate = /\b(set ?up|setup|build|make|start|create)\b/.test(lower);
  return asksForBase && asksToCreate;
}

export function buildBaseSetupPlan({ text, quantity = null, sourceMessageId = null } = {}) {
  const planId = `${BASE_SETUP_SKILL_ID}:${sourceMessageId || Date.now()}`;
  const woodQuantity = quantity || 12;
  const stoneQuantity = quantity || 8;

  return {
    skill_id: BASE_SETUP_SKILL_ID,
    plan_id: planId,
    summary: "set up a new starter base",
    description: "Small/medium starter house with storage, furnace, crafting table, basic wooden tools, and enough room to expand.",
    trigger_text: text,
    jobs: [
      {
        plan_step: "forage_base_materials",
        kind: "gather_wood",
        target: "oak_log",
        quantity: woodQuantity,
        preferred_worker_id: AGENT_IDS.forager,
        preferred_worker_role: "forager",
        objective: [
          `Mine ${woodQuantity} oak logs near the group and stop once they are in your inventory.`,
          "Do not scout, craft maps, or try to update shared state; OpenClaw will record the result.",
        ].join(" "),
        voyager_sub_goals: [`Mine ${woodQuantity} oak_log`],
        outputs: [
          { item_name: "oak_log", count: woodQuantity },
        ],
        coordination_notes: [
          "Keep this task physical and small so Voyager does not over-plan.",
          "OpenClaw records the material result after Voyager returns.",
        ],
      },
      {
        plan_step: "mine_base_materials",
        kind: "gather_stone",
        target: "cobblestone",
        quantity: stoneQuantity,
        preferred_worker_id: AGENT_IDS.miner,
        preferred_worker_role: "miner",
        objective: [
          `Mine ${stoneQuantity} cobblestone near the group and stop once it is in your inventory.`,
          "If stone is not reachable, mine dirt as a fallback and report the blocker; do not scout or craft maps.",
        ].join(" "),
        voyager_sub_goals: [`Mine ${stoneQuantity} cobblestone`],
        outputs: [
          { item_name: "cobblestone", count: stoneQuantity },
        ],
        coordination_notes: [
          "Keep this task physical and small so Voyager does not over-plan.",
          "OpenClaw records the material result after Voyager returns.",
        ],
      },
      {
        plan_step: "prepare_base_site",
        kind: "build_base",
        target: "base_site",
        quantity: 1,
        preferred_worker_id: AGENT_IDS.builder,
        preferred_worker_role: "builder",
        objective: [
          "Prepare a tiny starter site with your own materials.",
          "Mine a few logs, craft planks and a crafting table, place the crafting table, then place a simple 3 by 3 plank floor near you.",
          "Do not try to update shared state from inside Minecraft.",
        ].join(" "),
        voyager_sub_goals: [
          "Mine 4 oak_log",
          "Craft 12 oak_planks",
          "Craft 1 crafting_table",
          "Place 1 crafting_table",
          "Place a 3 by 3 oak_planks floor near you",
        ],
        outputs: [
          { item_name: "base_site_prepared", count: 1 },
          { item_name: "crafting_table", count: 1 },
        ],
        coordination_notes: [
          "Start immediately so all three agents are active while materials are gathered.",
          "Leave final construction for the build_starter_base step.",
        ],
      },
      {
        plan_step: "build_starter_base",
        kind: "build_base",
        target: "starter_base",
        quantity: 1,
        preferred_worker_id: AGENT_IDS.builder,
        preferred_worker_role: "builder",
        depends_on: ["forage_base_materials", "mine_base_materials", "prepare_base_site"],
        objective: [
          "Improve the prepared starter site with your own gathered materials.",
          "Keep it tiny: add low walls around the 3 by 3 floor and stop. Do not craft maps, mine diamonds, or attempt DB/shared-state actions.",
        ].join(" "),
        voyager_sub_goals: [
          "Mine 6 oak_log",
          "Craft 24 oak_planks",
          "Place oak_planks walls around the 3 by 3 floor",
        ],
        required_materials: [
          { item_name: "oak_log", count: woodQuantity },
          { item_name: "cobblestone", count: stoneQuantity },
        ],
        outputs: [
          { item_name: "starter_base", count: 1 },
          { item_name: "chest", count: 2 },
          { item_name: "furnace", count: 1 },
          { item_name: "crafting_table", count: 1 },
          { item_name: "wooden_tools", count: 1 },
        ],
        coordination_notes: [
          "Use the prepared site note from the builder's first step.",
          "Before building, read Supabase jobs_history and agent_memory for the forager/miner outputs.",
          "If materials are missing, report what is missing instead of pretending the base is done.",
        ],
      },
    ],
  };
}
