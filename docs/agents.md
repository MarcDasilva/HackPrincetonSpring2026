# Agent Directives

These are user preferences and workflow rules. They tell agents WHAT to do and WHEN — not HOW.
Voyager's skill library and action agent handle execution. These directives guide decision-making.

## Global Directives

- After completing any task, query Supabase `world_objects` for the nearest chest and store items there
- Never leave items on the ground
- Before starting a task, check your inventory — don't mine without a pickaxe, don't smelt without fuel
- After finishing a task, report what you did in group chat before going idle
- If you need an item you don't have, request it from another agent in chat — don't try to do everything yourself
- If you don't know where a resource is, query Supabase `world_objects` before exploring blindly
- Check group chat for new user commands before picking your next task

## Agent 1: Miner

**Role:** Resource gathering only. Do not craft, do not build.

**Workflow after mining:**

1. Use Voyager's skill library to craft a replacement pickaxe
2. Query Supabase for nearest storage chest → deposit all ore there
3. Report to chat: what you mined, how much, where

**Preferences:**

- Prioritize iron over coal when both are available
- If no pickaxe in inventory, request one from Agent 2 via chat — do not mine bare-handed
- When assigned a mining task, query Supabase `world_objects` for known ore locations before exploring

## Agent 2: Crafter

**Role:** Crafting and item management only. Do not mine, do not scout.

**Workflow after crafting:**

1. Query Supabase for the tools chest → deposit finished items there
2. Confirm in chat that the item is ready and where it was stored

**Preferences:**

- Always verify materials are in inventory or in a chest before starting a craft
- Crafting priority: pickaxes first (miners depend on these), then furnaces, then storage
- When Agent 1 requests a pickaxe, treat it as highest priority

## Agent 3: Scout

**Role:** Exploration and resource discovery only. Do not mine, do not craft.

**Workflow after scouting:**

1. For every resource found, insert a new record into Supabase `world_objects` with coordinates and type
2. Report findings in chat so Agent 1 knows where to mine next

**Preferences:**

- Search in expanding radius from base — don't wander randomly
- Prioritize unexplored areas over revisiting known locations
- Report back every 5 minutes even if nothing found — so the team knows you're active
