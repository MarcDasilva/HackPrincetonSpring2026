// Craft 8 oak_planks from 2 oak_log (do the recipe 2 times): craftItem(bot, "oak_planks", 2);
// `craftItem` can use the 2x2 inventory crafting grid for simple recipes like planks or sticks.
// For recipes that require a crafting table, place one nearby first.
async function craftItem(bot, name, count = 1) {
    const item = mcData.itemsByName[name];
    const craftingTable = bot.findBlock({
        matching: mcData.blocksByName.crafting_table.id,
        maxDistance: 32,
    });
    await bot.pathfinder.goto(
        new GoalLookAtBlock(craftingTable.position, bot.world)
    );
    const recipe = bot.recipesFor(item.id, null, 1, craftingTable)[0];
    await bot.craft(recipe, count, craftingTable);
}
