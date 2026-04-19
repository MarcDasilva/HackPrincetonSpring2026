export const JOB_KINDS = Object.freeze({
  mineOre: "mine_ore",
  gatherFood: "gather_food",
  expandStorage: "expand_storage",
  craftTools: "craft_tools",
  smeltOre: "smelt_ore",
  craftTorches: "craft_torches",
  scout: "scout",
  gatherWood: "gather_wood",
  returnToBase: "return_to_base",
  reportStatus: "report_status",
  inventoryCheck: "inventory_check",
});

export const JOB_CAPABILITIES = Object.freeze({
  [JOB_KINDS.mineOre]: ["miner", "builder"],
  [JOB_KINDS.gatherFood]: ["forager"],
  [JOB_KINDS.expandStorage]: ["builder"],
  [JOB_KINDS.craftTools]: ["builder", "miner"],
  [JOB_KINDS.smeltOre]: ["builder"],
  [JOB_KINDS.craftTorches]: ["miner", "builder"],
  [JOB_KINDS.scout]: ["forager"],
  [JOB_KINDS.gatherWood]: ["forager", "builder"],
  [JOB_KINDS.returnToBase]: ["miner", "builder", "forager"],
  [JOB_KINDS.reportStatus]: ["miner", "builder", "forager"],
  [JOB_KINDS.inventoryCheck]: ["miner", "builder", "forager"],
});

export function normalizeJobKind(kind) {
  if (!kind) return null;
  const value = String(kind).trim().toLowerCase().replaceAll(" ", "_");
  return Object.values(JOB_KINDS).includes(value) ? value : null;
}

export function inferJobKindFromText(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("return") && lower.includes("base")) return JOB_KINDS.returnToBase;
  if (lower.includes("status")) return JOB_KINDS.reportStatus;
  if (lower.includes("inventory")) return JOB_KINDS.inventoryCheck;
  if (lower.includes("dirt") || lower.includes("sand") || lower.includes("gravel") || lower.includes("clay") || lower.includes("material")) return JOB_KINDS.mineOre;
  if (lower.includes("iron") || lower.includes("ore") || lower.includes("mine")) return JOB_KINDS.mineOre;
  if (lower.includes("food") || lower.includes("farm") || lower.includes("hungry")) return JOB_KINDS.gatherFood;
  if (lower.includes("storage") || lower.includes("chest")) return JOB_KINDS.expandStorage;
  if (lower.includes("torch")) return JOB_KINDS.craftTorches;
  if (lower.includes("pickaxe") || lower.includes("tool")) return JOB_KINDS.craftTools;
  if (lower.includes("smelt") || lower.includes("furnace")) return JOB_KINDS.smeltOre;
  if (lower.includes("wood") || lower.includes("log")) return JOB_KINDS.gatherWood;
  if (lower.includes("scout") || lower.includes("explore")) return JOB_KINDS.scout;
  return JOB_KINDS.scout;
}

export function inferTargetFromText(text, kind) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("dirt")) return "dirt";
  if (lower.includes("sand")) return "sand";
  if (lower.includes("gravel")) return "gravel";
  if (lower.includes("clay")) return "clay";
  if (lower.includes("iron")) return kind === JOB_KINDS.smeltOre ? "raw_iron" : "iron_ore";
  if (lower.includes("coal")) return "coal";
  if (lower.includes("food")) return "cooked_food";
  if (lower.includes("chest") || lower.includes("storage")) return "base_storage";
  if (lower.includes("torch")) return "torch";
  if (lower.includes("pickaxe")) return "pickaxe";
  if (lower.includes("wood") || lower.includes("log")) return "oak_log";
  return null;
}

export function inferQuantityFromText(text) {
  const match = String(text || "").match(/\b(\d{1,3})\b/);
  return match ? Number(match[1]) : null;
}
