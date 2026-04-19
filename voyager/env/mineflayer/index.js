const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const mineflayer = require("mineflayer");

const skills = require("./lib/skillLoader");
const { initCounter, getNextTime } = require("./lib/utils");
const obs = require("./lib/observation/base");
const OnChat = require("./lib/observation/onChat");
const OnError = require("./lib/observation/onError");
const { Voxels, BlockRecords } = require("./lib/observation/voxels");
const Status = require("./lib/observation/status");
const Inventory = require("./lib/observation/inventory");
const OnSave = require("./lib/observation/onSave");
const Chests = require("./lib/observation/chests");
const { plugin: tool } = require("mineflayer-tool");

let bot = null;
let keepAliveInterval = null;
const EXTERNAL_TELEPORT_CANCEL_ENABLED =
    `${process.env.VOYAGER_CANCEL_GOAL_ON_EXTERNAL_TELEPORT || "1"}` !== "0";
const EXTERNAL_TELEPORT_HOLD_MS = Math.max(
    0,
    parseInt(process.env.VOYAGER_EXTERNAL_TELEPORT_HOLD_MS || "8000", 10)
);
const INTERNAL_TELEPORT_GRACE_MS = Math.max(
    0,
    parseInt(process.env.VOYAGER_INTERNAL_TELEPORT_GRACE_MS || "2500", 10)
);

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: false }));

function clearKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

function startKeepAlive(currentBot) {
    clearKeepAlive();
    keepAliveInterval = setInterval(() => {
        if (!currentBot || currentBot !== bot) {
            clearKeepAlive();
            return;
        }
        if (!currentBot.entity) return;
        if (currentBot.pathfinder?.isMoving?.()) return;

        try {
            currentBot.look(
                currentBot.entity.yaw + 0.35,
                currentBot.entity.pitch,
                true
            ).catch(() => {});
            currentBot.setControlState("jump", true);
            setTimeout(() => {
                if (currentBot === bot) {
                    currentBot.setControlState("jump", false);
                }
            }, 350);
        } catch (error) {
            console.log(`Keepalive tick failed: ${error.message}`);
        }
    }, 15000);
}

function teardownBot(targetBot, reason = "") {
    if (!targetBot || targetBot._voyagerDisconnecting) return;
    targetBot._voyagerDisconnecting = true;
    clearKeepAlive();
    try {
        if (targetBot.viewer) targetBot.viewer.close();
    } catch (error) {}
    try {
        targetBot.end();
    } catch (error) {}
    if (reason) {
        console.log(typeof reason === "string" ? reason : formatError(reason));
    }
    if (targetBot === bot) {
        bot = null;
    }
}

function clearMovementIntent(currentBot, reason = "") {
    if (!currentBot) return;
    try {
        if (currentBot.pathfinder?.setGoal) {
            currentBot.pathfinder.setGoal(null);
        }
    } catch (error) {}
    try {
        if (currentBot.pathfinder?.stop) {
            currentBot.pathfinder.stop();
        }
    } catch (error) {}
    try {
        if (typeof currentBot.clearControlStates === "function") {
            currentBot.clearControlStates();
        } else if (typeof currentBot.setControlState === "function") {
            for (const control of ["forward", "back", "left", "right", "jump", "sprint", "sneak"]) {
                currentBot.setControlState(control, false);
            }
        }
    } catch (error) {}
    currentBot.stuckTickCounter = 0;
    currentBot.stuckPosList = [];
    if (reason) {
        console.log(reason);
    }
}

function inExternalTeleportHold(currentBot) {
    if (!currentBot) return false;
    return Date.now() < (currentBot.externalTeleportHoldUntil || 0);
}

function formatError(error) {
    if (!error) return "Unknown error";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    try {
        return JSON.stringify(error);
    } catch (jsonError) {
        return String(error);
    }
}

async function safeWaitForTicks(currentBot, ticks, label = "waitForTicks") {
    if (!currentBot || typeof currentBot.waitForTicks !== "function") {
        return false;
    }
    try {
        await currentBot.waitForTicks(ticks);
        return true;
    } catch (error) {
        console.log(
            `[VOYAGER] ${label} failed (ticks=${ticks}): ${formatError(error)}`
        );
        return false;
    }
}

process.on("unhandledRejection", (reason) => {
    console.log(`[VOYAGER] Unhandled rejection: ${formatError(reason)}`);
});

app.post("/start", (req, res) => {
    if (bot && req.body.reset !== "hard") {
        try {
            return res.json(bot.observe());
        } catch (error) {
            console.log(`Existing bot observe failed, restarting: ${error.message}`);
        }
    }
    if (bot) {
        teardownBot(bot, "Restarting bot");
    }
    console.log(req.body);
    const botOptions = {
        host: req.body.host || "localhost",
        port: req.body.port,
        username: req.body.username || "bot",
        disableChatSigning: true,
        checkTimeoutInterval: 60 * 60 * 1000,
    };
    if (req.body.auth) botOptions.auth = req.body.auth;
    if (req.body.password) botOptions.password = req.body.password;
    if (req.body.version) botOptions.version = req.body.version;
    if (req.body.profilesFolder) botOptions.profilesFolder = req.body.profilesFolder;
    bot = mineflayer.createBot(botOptions);
    const currentBot = bot;
    currentBot.once("error", onConnectionFailed);

    // Event subscriptions
    currentBot.waitTicks = req.body.waitTicks;
    currentBot.globalTickCounter = 0;
    currentBot.stuckTickCounter = 0;
    currentBot.stuckPosList = [];
    currentBot.iron_pickaxe = false;

    currentBot.on("kicked", onDisconnect);
    currentBot.on("end", () => onDisconnect("Bot connection ended"));

    // mounting will cause physicsTick to stop
    currentBot.on("mount", () => {
        try {
            currentBot.dismount();
        } catch (error) {}
    });

    currentBot.once("spawn", async () => {
        if (currentBot !== bot) return;
        currentBot.removeListener("error", onConnectionFailed);
        let itemTicks = 1;
        try {
            if (req.body.reset === "hard") {
                currentBot.chat("/clear @s");
                const inventory = req.body.inventory ? req.body.inventory : {};
                const equipment = req.body.equipment
                    ? req.body.equipment
                    : [null, null, null, null, null, null];
                for (let key in inventory) {
                    currentBot.chat(`/give @s minecraft:${key} ${inventory[key]}`);
                    itemTicks += 1;
                }
                const equipmentNames = [
                    "armor.head",
                    "armor.chest",
                    "armor.legs",
                    "armor.feet",
                    "weapon.mainhand",
                    "weapon.offhand",
                ];
                for (let i = 0; i < 6; i++) {
                    if (i === 4) continue;
                    if (equipment[i]) {
                        currentBot.chat(
                            `/item replace entity @s ${equipmentNames[i]} with minecraft:${equipment[i]}`
                        );
                        itemTicks += 1;
                    }
                }
            }

            if (req.body.position) {
                currentBot.internalTeleportAt = Date.now();
                currentBot.chat(
                    `/tp @s ${req.body.position.x} ${req.body.position.y} ${req.body.position.z}`
                );
            }

            // if iron_pickaxe is in bot's inventory
            if (
                currentBot.inventory.items().find((item) => item.name === "iron_pickaxe")
            ) {
                currentBot.iron_pickaxe = true;
            }

            const { pathfinder } = require("mineflayer-pathfinder");
            const tool = require("mineflayer-tool").plugin;
            const collectBlock = require("mineflayer-collectblock").plugin;
            const pvp = require("mineflayer-pvp").plugin;
            const minecraftHawkEyeModule = require("minecrafthawkeye");
            const minecraftHawkEye =
                minecraftHawkEyeModule.plugin ||
                minecraftHawkEyeModule.default ||
                minecraftHawkEyeModule;
            currentBot.loadPlugin(pathfinder);
            currentBot.loadPlugin(tool);
            currentBot.loadPlugin(collectBlock);
            currentBot.loadPlugin(pvp);
            currentBot.loadPlugin(minecraftHawkEye);
            currentBot.externalTeleportHoldUntil = 0;
            currentBot.internalTeleportAt = 0;

            currentBot.on("forcedMove", () => {
                if (!EXTERNAL_TELEPORT_CANCEL_ENABLED) return;
                const now = Date.now();
                const lastInternalTeleportAt = currentBot.internalTeleportAt || 0;
                const internalTeleport =
                    now - lastInternalTeleportAt <= INTERNAL_TELEPORT_GRACE_MS;
                if (internalTeleport) return;

                currentBot.externalTeleportHoldUntil = now + EXTERNAL_TELEPORT_HOLD_MS;
                clearMovementIntent(
                    currentBot,
                    `[VOYAGER] External teleport detected; pausing path goals for ${Math.round(
                        EXTERNAL_TELEPORT_HOLD_MS / 1000
                    )}s.`
                );
            });

            // currentBot.collectBlock.movements.digCost = 0;
            // currentBot.collectBlock.movements.placeCost = 0;

            obs.inject(currentBot, [
                OnChat,
                OnError,
                Voxels,
                Status,
                Inventory,
                OnSave,
                Chests,
                BlockRecords,
            ]);
            skills.inject(currentBot);

            if (req.body.spread) {
                currentBot.chat(`/spreadplayers ~ ~ 0 300 under 80 false @s`);
                await safeWaitForTicks(
                    currentBot,
                    currentBot.waitTicks,
                    "start spreadplayers"
                );
            }

            await safeWaitForTicks(
                currentBot,
                currentBot.waitTicks * itemTicks,
                "start reset sync"
            );
            if (!res.headersSent) {
                if (currentBot !== bot) {
                    res.status(503).json({ error: "Bot was replaced during startup" });
                } else {
                    res.json(currentBot.observe());
                }
            }

            initCounter(currentBot);
            startKeepAlive(currentBot);
            currentBot.chat("/gamerule keepInventory true");
            currentBot.chat("/gamerule doDaylightCycle false");
        } catch (error) {
            console.log(`[VOYAGER] /start setup failed: ${formatError(error)}`);
            if (!res.headersSent) {
                res.status(500).json({ error: formatError(error) });
            }
            onDisconnect(`Start pipeline failed: ${formatError(error)}`);
        }
    });

    function onConnectionFailed(e) {
        if (currentBot !== bot) return;
        teardownBot(currentBot, e);
        if (!res.headersSent) {
            res.status(400).json({ error: formatError(e) });
        }
    }
    function onDisconnect(message) {
        const disconnectMessage =
            typeof message === "string" ? message : formatError(message);
        teardownBot(currentBot, disconnectMessage);
        if (!res.headersSent) {
            res.status(503).json({
                error: `Bot disconnected during startup: ${disconnectMessage}`,
            });
        }
    }
});

app.post("/step", async (req, res) => {
    if (!bot) {
        return res.status(503).json({ error: "Bot not spawned" });
    }

    // import useful package
    let response_sent = false;
    async function otherError(err) {
        console.log("Uncaught Error");
        try {
            bot.emit("error", handleError(err));
        } catch (emitError) {}
        await safeWaitForTicks(bot, bot.waitTicks, "step uncaught error recovery");
        if (!response_sent) {
            response_sent = true;
            try {
                res.json(bot.observe());
            } catch (observeError) {
                res.status(500).json({ error: formatError(observeError) });
            }
        }
    }
    const otherRejection = (reason) => otherError(reason);

    process.on("uncaughtException", otherError);
    process.on("unhandledRejection", otherRejection);

    const mcData = require("minecraft-data")(bot.version);
    mcData.itemsByName["leather_cap"] = mcData.itemsByName["leather_helmet"];
    mcData.itemsByName["leather_tunic"] =
        mcData.itemsByName["leather_chestplate"];
    mcData.itemsByName["leather_pants"] =
        mcData.itemsByName["leather_leggings"];
    mcData.itemsByName["leather_boots"] = mcData.itemsByName["leather_boots"];
    mcData.itemsByName["lapis_lazuli_ore"] = mcData.itemsByName["lapis_ore"];
    mcData.blocksByName["lapis_lazuli_ore"] = mcData.blocksByName["lapis_ore"];
    const {
        Movements,
        goals: {
            Goal,
            GoalBlock,
            GoalNear,
            GoalXZ,
            GoalNearXZ,
            GoalY,
            GoalGetToBlock,
            GoalLookAtBlock,
            GoalBreakBlock,
            GoalCompositeAny,
            GoalCompositeAll,
            GoalInvert,
            GoalFollow,
            GoalPlaceBlock,
        },
        pathfinder,
        Move,
        ComputedPath,
        PartiallyComputedPath,
        XZCoordinates,
        XYZCoordinates,
        SafeBlock,
        GoalPlaceBlockOptions,
    } = require("mineflayer-pathfinder");
    const { Vec3 } = require("vec3");

    // Set up pathfinder
    const movements = new Movements(bot, mcData);
    bot.pathfinder.setMovements(movements);

    bot.globalTickCounter = 0;
    bot.stuckTickCounter = 0;
    bot.stuckPosList = [];

    function onTick() {
        try {
            if (!bot || !bot.entity) return;
            if (inExternalTeleportHold(bot)) {
                clearMovementIntent(bot);
                return;
            }
            bot.globalTickCounter++;
            if (bot.pathfinder?.isMoving?.()) {
                bot.stuckTickCounter++;
                if (bot.stuckTickCounter >= 100) {
                    onStuck(1.5);
                    bot.stuckTickCounter = 0;
                }
            }
        } catch (error) {
            console.log(`[VOYAGER] physicsTick handler failed: ${formatError(error)}`);
        }
    }

    bot.on("physicsTick", onTick);

    // initialize fail count
    let _craftItemFailCount = 0;
    let _killMobFailCount = 0;
    let _mineBlockFailCount = 0;
    let _placeItemFailCount = 0;
    let _smeltItemFailCount = 0;

    // Retrieve array form post bod
    const code = req.body.code;
    const programs = req.body.programs;
    bot.cumulativeObs = [];
    try {
        await safeWaitForTicks(bot, bot.waitTicks, "step pre-run sync");
        const r = await evaluateCode(code, programs);
        if (r !== "success") {
            bot.emit("error", handleError(r));
        }
        await returnItems();
        // wait for last message
        await safeWaitForTicks(bot, bot.waitTicks, "step post-run sync");
        if (!response_sent) {
            response_sent = true;
            try {
                res.json(bot.observe());
            } catch (observeError) {
                res.status(500).json({ error: formatError(observeError) });
            }
        }
    } catch (stepError) {
        console.log(`[VOYAGER] /step execution failed: ${formatError(stepError)}`);
        if (!response_sent) {
            response_sent = true;
            res.status(500).json({ error: formatError(stepError) });
        }
    } finally {
        process.off("uncaughtException", otherError);
        process.off("unhandledRejection", otherRejection);
        bot.removeListener("physicsTick", onTick);
    }

    async function evaluateCode(code, programs) {
        // Echo the code produced for players to see it. Don't echo when the bot code is already producing dialog or it will double echo
        try {
            await eval("(async () => {" + programs + "\n" + code + "})()");
            return "success";
        } catch (err) {
            return err;
        }
    }

    function onStuck(posThreshold) {
        const currentPos = bot.entity.position;
        bot.stuckPosList.push(currentPos);

        // Check if the list is full
        if (bot.stuckPosList.length === 5) {
            const oldestPos = bot.stuckPosList[0];
            const posDifference = currentPos.distanceTo(oldestPos);

            if (posDifference < posThreshold) {
                teleportBot(); // execute the function
            }

            // Remove the oldest time from the list
            bot.stuckPosList.shift();
        }
    }

    function teleportBot() {
        const blocks = bot.findBlocks({
            matching: (block) => {
                return block.type === 0;
            },
            maxDistance: 1,
            count: 27,
        });

        if (blocks) {
            // console.log(blocks.length);
            const randomIndex = Math.floor(Math.random() * blocks.length);
            const block = blocks[randomIndex];
            bot.internalTeleportAt = Date.now();
            bot.chat(`/tp @s ${block.x} ${block.y} ${block.z}`);
        } else {
            bot.internalTeleportAt = Date.now();
            bot.chat("/tp @s ~ ~1.25 ~");
        }
    }

    function returnItems() {
        bot.chat("/gamerule doTileDrops false");
        const crafting_table = bot.findBlock({
            matching: mcData.blocksByName.crafting_table.id,
            maxDistance: 128,
        });
        if (crafting_table) {
            bot.chat(
                `/setblock ${crafting_table.position.x} ${crafting_table.position.y} ${crafting_table.position.z} air destroy`
            );
            bot.chat("/give @s crafting_table");
        }
        const furnace = bot.findBlock({
            matching: mcData.blocksByName.furnace.id,
            maxDistance: 128,
        });
        if (furnace) {
            bot.chat(
                `/setblock ${furnace.position.x} ${furnace.position.y} ${furnace.position.z} air destroy`
            );
            bot.chat("/give @s furnace");
        }
        if (bot.inventoryUsed() >= 32) {
            // if chest is not in bot's inventory
            if (!bot.inventory.items().find((item) => item.name === "chest")) {
                bot.chat("/give @s chest");
            }
        }
        // if iron_pickaxe not in bot's inventory and bot.iron_pickaxe
        if (
            bot.iron_pickaxe &&
            !bot.inventory.items().find((item) => item.name === "iron_pickaxe")
        ) {
            bot.chat("/give @s iron_pickaxe");
        }
        bot.chat("/gamerule doTileDrops true");
    }

    function handleError(err) {
        let stack = err.stack;
        if (!stack) {
            return err;
        }
        console.log(stack);
        const final_line = stack.split("\n")[1];
        const regex = /<anonymous>:(\d+):\d+\)/;

        const programs_length = programs.split("\n").length;
        let match_line = null;
        for (const line of stack.split("\n")) {
            const match = regex.exec(line);
            if (match) {
                const line_num = parseInt(match[1]);
                if (line_num >= programs_length) {
                    match_line = line_num - programs_length;
                    break;
                }
            }
        }
        if (!match_line) {
            return err.message;
        }
        let f_line = final_line.match(
            /\((?<file>.*):(?<line>\d+):(?<pos>\d+)\)/
        );
        if (f_line && f_line.groups && fs.existsSync(f_line.groups.file)) {
            const { file, line, pos } = f_line.groups;
            const f = fs.readFileSync(file, "utf8").split("\n");
            // let filename = file.match(/(?<=node_modules\\)(.*)/)[1];
            let source = file + `:${line}\n${f[line - 1].trim()}\n `;

            const code_source =
                "at " +
                code.split("\n")[match_line - 1].trim() +
                " in your code";
            return source + err.message + "\n" + code_source;
        } else if (
            f_line &&
            f_line.groups &&
            f_line.groups.file.includes("<anonymous>")
        ) {
            const { file, line, pos } = f_line.groups;
            let source =
                "Your code" +
                `:${match_line}\n${code.split("\n")[match_line - 1].trim()}\n `;
            let code_source = "";
            if (line < programs_length) {
                source =
                    "In your program code: " +
                    programs.split("\n")[line - 1].trim() +
                    "\n";
                code_source = `at line ${match_line}:${code
                    .split("\n")
                    [match_line - 1].trim()} in your code`;
            }
            return source + err.message + "\n" + code_source;
        }
        return err.message;
    }
});

app.post("/stop", (req, res) => {
    if (!bot) {
        return res.json({
            message: "Bot already stopped",
        });
    }
    try {
        bot.end();
    } catch (error) {}
    bot = null;
    res.json({
        message: "Bot stopped",
    });
});

app.post("/pause", (req, res) => {
    if (!bot) {
        res.status(400).json({ error: "Bot not spawned" });
        return;
    }
    bot.chat("/pause");
    safeWaitForTicks(bot, bot.waitTicks, "pause toggle").then(() => {
        res.json({ message: "Success" });
    });
});

// Server listening to PORT 3000

const DEFAULT_PORT = 3000;
const PORT = process.argv[2] || DEFAULT_PORT;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
