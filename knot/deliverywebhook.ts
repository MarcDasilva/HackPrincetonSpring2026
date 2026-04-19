import express from 'express';
import mineflayer from 'mineflayer';
import { pathfinder, goals, Movements } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { getSeedTransactions } from './seed-transactions.js';

const app = express();
app.use(express.json());

// ============================================
// Config
// ============================================

const KNOT_CLIENT_ID = 'dda0778d-9486-47f8-bd80-6f2512f9bcdb';
const KNOT_SECRET = 'ff5e51b6dcf84a829898d37449cbc47a';
const KNOT_AUTH = Buffer.from(`${KNOT_CLIENT_ID}:${KNOT_SECRET}`).toString('base64');
const KNOT_API_URL = 'https://development.knotapi.com';
const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT = parseInt(process.env.MC_PORT || '63660');
const MC_VERSION = process.env.MC_VERSION;
const PLAYER_NAME = process.env.PLAYER_NAME || 'chefdajeff';
const BOT_USERNAME = process.env.BOT_USERNAME || 'AmazonDriver';
const BOT_AUTH = process.env.BOT_AUTH || 'offline';
const BOT_PASSWORD = process.env.BOT_PASSWORD;
const RECONNECT_DELAY_MS = 5000;
const AUTO_DELIVER_ON_START = process.env.AUTO_DELIVER_ON_START !== 'false';

// ============================================
// Helpers
// ============================================

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================
// Delivery bot
// ============================================

let bot: any = null;
let botReady = false;
let deliveryInProgress = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let isConnecting = false;
let connectionAttempts = 0;
let lastDisconnectReason = 'not connected';
let lastAutoPlaceAt = 0;
let startupDeliveryTriggered = false;
let startupDeliveryTimer: NodeJS.Timeout | null = null;

type Position = { x: number; y: number; z: number };

const COMMAND_TIMEOUT_MS = 5000;
const GOAL_TIMEOUT_MS = 20000;
const AUTO_PLACE_COOLDOWN_MS = 3000;
const DELIVERY_SPAWN_OFFSETS: Array<[number, number]> = [
  [10, 0],
  [8, 6],
  [6, 8],
  [0, 10],
  [-6, 8],
  [-8, 6],
  [-10, 0],
  [-8, -6],
  [-6, -8],
  [0, -10],
  [6, -8],
  [8, -6],
  [7, 7],
  [-7, 7],
  [7, -7],
  [-7, -7],
  [5, 0],
  [0, 5],
  [-5, 0],
  [0, -5],
];

function formatPos(pos: Position) {
  return `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
}

function distance(a: Position, b: Position) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function getBotPosition(): Position | null {
  const pos = bot?.entity?.position;
  if (!pos) return null;
  return { x: pos.x, y: pos.y, z: pos.z };
}

function getTrackedPlayerPosition(): Position | null {
  const pos = bot?.players?.[PLAYER_NAME]?.entity?.position;
  if (!pos) return null;
  return { x: pos.x, y: pos.y, z: pos.z };
}

function getTrackedPlayerEntity(): any | null {
  return bot?.players?.[PLAYER_NAME]?.entity || null;
}

function createDeliveryMovements() {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.allowFreeMotion = false;
  movements.scafoldingBlocks = [];
  return movements;
}

function isSolidGroundBlock(block: any) {
  return block?.boundingBox === 'block';
}

function isPassableBlock(block: any) {
  return block?.boundingBox === 'empty';
}

function toCenteredPosition(pos: Vec3): Position {
  return { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 };
}

function findInventoryItemByName(itemName: string) {
  return bot?.inventory?.items?.().find((item: any) => item.name === itemName) || null;
}

function scheduleStartupDelivery(reason: string) {
  if (!AUTO_DELIVER_ON_START || startupDeliveryTriggered || deliveryInProgress || !botReady) return;

  if (startupDeliveryTimer) {
    clearTimeout(startupDeliveryTimer);
  }

  startupDeliveryTimer = setTimeout(async () => {
    if (startupDeliveryTriggered || deliveryInProgress || !botReady) return;
    startupDeliveryTriggered = true;
    startupDeliveryTimer = null;

    console.log(`[DELIVERY] Auto-triggering startup delivery after ${reason}`);

    try {
      const products = await getOrderProducts();
      await triggerDelivery(products);
    } catch (err: any) {
      console.error(`[DELIVERY] Startup delivery failed: ${err.message}`);
      startupDeliveryTriggered = false;
    }
  }, 2000);
}

function createDeliveryBot() {
  if (isConnecting) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  isConnecting = true;
  connectionAttempts += 1;
  lastDisconnectReason = 'connecting';

  console.log(
    `[DELIVERY] Connecting ${BOT_USERNAME} to ${MC_HOST}:${MC_PORT} (auth=${BOT_AUTH}${MC_VERSION ? `, version=${MC_VERSION}` : ''}, attempt=${connectionAttempts})`,
  );

  const botOptions: any = {
    host: MC_HOST,
    port: MC_PORT,
    username: BOT_USERNAME,
    auth: BOT_AUTH as 'offline' | 'microsoft',
    password: BOT_PASSWORD,
  };

  if (MC_VERSION) {
    botOptions.version = MC_VERSION;
  }

  bot = mineflayer.createBot(botOptions);

  bot.loadPlugin(pathfinder);

  bot.on('login', () => {
    isConnecting = false;
    lastDisconnectReason = 'logged in';
    console.log(`[DELIVERY] ${BOT_USERNAME} logged into ${MC_HOST}:${MC_PORT}`);
  });

  bot.on('spawn', () => {
    botReady = true;
    bot.pathfinder.setMovements(createDeliveryMovements());
    const pos = getBotPosition();
    lastDisconnectReason = 'spawned';
    console.log(`[DELIVERY] ${BOT_USERNAME} ready${pos ? ` at ${formatPos(pos)}` : ''}`);
    void placeDriverNearPlayer('bot spawn');
  });

  bot.on('playerJoined', (player: any) => {
    if (player.username === PLAYER_NAME) {
      console.log(`[DELIVERY] Tracking player ${PLAYER_NAME}`);
      void placeDriverNearPlayer('player join');
    }
  });

  bot.on('playerUpdated', (player: any) => {
    if (player.username === PLAYER_NAME) {
      void placeDriverNearPlayer('player update');
    }
  });

  bot.on('end', (reason: string) => {
    isConnecting = false;
    botReady = false;
    deliveryInProgress = false;
    lastDisconnectReason = reason || 'connection ended';
    console.log(`[DELIVERY] ${BOT_USERNAME} disconnected: ${lastDisconnectReason}`);
    reconnectTimer = setTimeout(createDeliveryBot, RECONNECT_DELAY_MS);
  });

  bot.on('messagestr', (msg: any) => {
    const text = msg.toString();
    if (/permission|unknown command|unknown or incomplete command|no entity was found/i.test(text)) {
      console.log(`[MC] ${text}`);
    }
  });

  bot.on('error', (err: any) => {
    isConnecting = false;
    lastDisconnectReason = err.message;
    console.error('[DELIVERY] Error:', err);
  });

  bot.on('kicked', (reason: any) => {
    lastDisconnectReason = typeof reason === 'string' ? reason : JSON.stringify(reason);
    console.log('[DELIVERY] Kicked:', reason);
  });
}

function waitForGoal(target: Position): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (reached: boolean) => {
      if (settled) return;
      settled = true;
      bot.removeListener('goal_reached', onGoalReached);
      clearTimeout(timer);
      resolve(reached);
    };

    const onGoalReached = () => finish(true);
    const timer = setTimeout(() => {
      const botPos = getBotPosition();
      console.warn(
        `[DELIVERY] Timed out walking to ${formatPos(target)}${botPos ? ` from ${formatPos(botPos)}` : ''}`,
      );
      finish(false);
    }, GOAL_TIMEOUT_MS);

    bot.once('goal_reached', onGoalReached);
  });
}

async function getPlayerPosition(): Promise<Position> {
  const tracked = getTrackedPlayerPosition();
  if (tracked) return tracked;

  return new Promise((resolve, reject) => {
    const parseText = (text: string) => {
      const match = text.match(/\[(-?[\d.]+)d?, (-?[\d.]+)d?, (-?[\d.]+)d?\]/);
      if (!match) return;
      cleanup();
      resolve({ x: parseFloat(match[1]), y: parseFloat(match[2]), z: parseFloat(match[3]) });
    };

    const onMessageStr = (msg: any) => parseText(msg.toString());
    const onMessage = (msg: any) => parseText(msg.toString());

    const cleanup = () => {
      clearTimeout(timer);
      bot.removeListener('messagestr', onMessageStr);
      bot.removeListener('message', onMessage);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Could not locate ${PLAYER_NAME}. If ${BOT_USERNAME} is not opped, /data and /tp will fail.`));
    }, COMMAND_TIMEOUT_MS);

    bot.on('messagestr', onMessageStr);
    bot.on('message', onMessage);
    bot.chat(`/data get entity ${PLAYER_NAME} Pos`);
  });
}

function findSafeDeliverySpawnPosition(playerPos: Position): Position | null {
  const baseX = Math.floor(playerPos.x);
  const baseY = Math.floor(playerPos.y);
  const baseZ = Math.floor(playerPos.z);

  for (const [dx, dz] of DELIVERY_SPAWN_OFFSETS) {
    for (const dy of [1, 0, 2, -1]) {
      const candidate = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
      const below = bot.blockAt(candidate.offset(0, -1, 0), false);
      const feet = bot.blockAt(candidate, false);
      const head = bot.blockAt(candidate.offset(0, 1, 0), false);

      if (isSolidGroundBlock(below) && isPassableBlock(feet) && isPassableBlock(head)) {
        return toCenteredPosition(candidate);
      }
    }
  }

  return null;
}

async function teleportDriverTo(pos: Position, reason: string) {
  console.log(`[DELIVERY] Teleporting driver ${reason}: ${formatPos(pos)}`);
  bot.chat(`/tp ${BOT_USERNAME} ${pos.x} ${pos.y} ${pos.z}`);
  await sleep(750);
}

async function teleportDriverNear(playerPos: Position): Promise<Position> {
  const approximatePos = {
    x: Math.floor(playerPos.x) + 10.5,
    y: Math.floor(playerPos.y) + 2,
    z: Math.floor(playerPos.z) + 0.5,
  };

  await teleportDriverTo(approximatePos, 'near player');

  const safeSpawnPos = findSafeDeliverySpawnPosition(playerPos);
  if (safeSpawnPos && distance(safeSpawnPos, approximatePos) > 1) {
    await teleportDriverTo(safeSpawnPos, 'onto walkable ground');
  }

  const botPos = getBotPosition() || safeSpawnPos || approximatePos;
  if (distance(botPos, playerPos) <= 14) {
    console.log(`[DELIVERY] Driver is at ${formatPos(botPos)}`);
  } else {
    console.warn('[DELIVERY] Driver did not land near the target. /tp is likely being rejected by the server.');
  }

  return botPos;
}

async function lookAtPlayer() {
  const entity = getTrackedPlayerEntity();
  if (!entity) return;
  const target = entity.position.offset(0, entity.height ?? 1.6, 0);
  await bot.lookAt(target, true);
}

async function waitUntilNearPlayer(timeoutMs = GOAL_TIMEOUT_MS): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const botPos = getBotPosition();
    const playerPos = getTrackedPlayerPosition();

    if (botPos && playerPos && distance(botPos, playerPos) <= 3) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

function stopManualMovement() {
  for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const) {
    bot.setControlState(control, false);
  }
}

async function followPlayerForDelivery() {
  console.log(`[DELIVERY] Walking directly toward ${PLAYER_NAME} after delay`);

  bot.pathfinder.stop();
  stopManualMovement();

  let lastLoggedSecond = -1;
  let reached = false;
  const startedAt = Date.now();
  let previousBotPos: Position | null = null;
  let stalledLoops = 0;

  try {
    while (Date.now() - startedAt < GOAL_TIMEOUT_MS) {
      const playerPos = getTrackedPlayerPosition() || await getPlayerPosition().catch(() => null);
      const botPos = getBotPosition();

      if (!playerPos || !botPos) {
        await sleep(100);
        continue;
      }

      const horizontalDistance = Math.hypot(playerPos.x - botPos.x, playerPos.z - botPos.z);
      const verticalDifference = playerPos.y - botPos.y;

      if (distance(botPos, playerPos) <= 2.75) {
        reached = true;
        break;
      }

      const lookTarget = new Vec3(playerPos.x, botPos.y + Math.max(0.6, Math.min(1.6, verticalDifference + 1)), playerPos.z);
      await bot.lookAt(lookTarget, true);
      bot.setControlState('forward', horizontalDistance > 1.2);
      bot.setControlState('jump', verticalDifference > 0.45 || stalledLoops >= 3);

      if (previousBotPos && distance(botPos, previousBotPos) < 0.08) {
        stalledLoops += 1;
      } else {
        stalledLoops = 0;
      }

      if (stalledLoops === 4) {
        console.warn('[DELIVERY] Driver appears stuck during walk-up, trying a stronger push');
        bot.setControlState('jump', true);
      }

      previousBotPos = botPos;

      const elapsedSecond = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsedSecond !== lastLoggedSecond) {
        lastLoggedSecond = elapsedSecond;
        console.log(
          `[DELIVERY] Walking up to ${PLAYER_NAME}: bot=${formatPos(botPos)} target=${formatPos(playerPos)}`,
        );
      }

      await sleep(100);
    }

    if (!reached) {
      const playerPos = getTrackedPlayerPosition();
      console.warn(
        `[DELIVERY] Timed out walking up to ${PLAYER_NAME}${playerPos ? ` near ${formatPos(playerPos)}` : ''}`,
      );
    }
  } finally {
    stopManualMovement();
  }

  await lookAtPlayer().catch(() => {});
}

async function runBotCommand(command: string, settleMs = 350) {
  bot.chat(command);
  await sleep(settleMs);
}

async function clearBotInventory() {
  await runBotCommand(`/clear ${BOT_USERNAME}`, 500);
}

async function giveItemToBot(itemName: string, count: number) {
  await runBotCommand(`/give ${BOT_USERNAME} ${itemName} ${count}`);
}

async function equipItemInHand(itemName: string) {
  const item = findInventoryItemByName(itemName);
  if (!item) return false;

  try {
    await bot.equip(item, 'hand');
    return true;
  } catch (err: any) {
    console.warn(`[DELIVERY] Failed to equip ${itemName}: ${err.message}`);
    return false;
  }
}

async function tossItemToPlayer(itemName: string, count: number, label: string) {
  await giveItemToBot(itemName, count);
  await lookAtPlayer().catch(() => {});

  const item = findInventoryItemByName(itemName);
  if (!item) {
    console.warn(`[DELIVERY] ${itemName} never appeared in inventory, falling back to /give`);
    await runBotCommand(`/give ${PLAYER_NAME} ${itemName} ${count}`);
    return;
  }

  try {
    await bot.toss(item.type, item.metadata ?? null, count);
    console.log(`[DELIVERY] Dropped ${label} (${itemName}) x${count}`);
  } catch (err: any) {
    console.warn(`[DELIVERY] Failed to drop ${itemName}, falling back to /give: ${err.message}`);
    await runBotCommand(`/give ${PLAYER_NAME} ${itemName} ${count}`);
  }

  await sleep(400);
}

async function placeDriverNearPlayer(reason: string) {
  if (!bot || !botReady || deliveryInProgress) return;

  const now = Date.now();
  if (now - lastAutoPlaceAt < AUTO_PLACE_COOLDOWN_MS) return;
  lastAutoPlaceAt = now;

  try {
    const playerPos = getTrackedPlayerPosition() || await getPlayerPosition();
    console.log(`[DELIVERY] Positioning ${BOT_USERNAME} 10 blocks from ${PLAYER_NAME} after ${reason}`);
    await teleportDriverNear(playerPos);
    scheduleStartupDelivery(reason);
  } catch (err: any) {
    console.warn(`[DELIVERY] Could not auto-place ${BOT_USERNAME}: ${err.message}`);
  }
}

// ============================================
// Knot TransactionLink API
// ============================================

async function createSession(): Promise<string | null> {
  const res = await fetch(`${KNOT_API_URL}/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${KNOT_AUTH}`,
    },
    body: JSON.stringify({ type: 'transaction_link' }),
  });
  const data = await res.json();
  console.log('[KNOT] Session:', data?.session_id || 'created');
  return data?.session_id || null;
}

async function syncTransactions(sessionId: string): Promise<any[]> {
  const res = await fetch(`${KNOT_API_URL}/transactions/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${KNOT_AUTH}`,
    },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  console.log('[KNOT] Sync response:', JSON.stringify(data, null, 2));
  return data?.transactions || [];
}

async function listMerchants(): Promise<any[]> {
  const res = await fetch(`${KNOT_API_URL}/merchants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${KNOT_AUTH}`,
    },
    body: JSON.stringify({ type: 'transaction_link' }),
  });
  const data = await res.json();
  console.log('[KNOT] Merchants:', Array.isArray(data) ? `${data.length} available` : 'received');
  return Array.isArray(data) ? data : [];
}

// ============================================
// Product -> Minecraft item mapping
// ============================================

function mapProductToMinecraft(productName: string): string {
  const name = productName.toLowerCase();
  if (name.includes('fishing rod'))   return 'fishing_rod';
  if (name.includes('lantern') || name.includes('lamp') || name.includes('light')) return 'lantern';
  if (name.includes('leather') || name.includes('wallet')) return 'leather';
  if (name.includes('apple') || name.includes('juice'))   return 'apple';
  if (name.includes('notebook') || name.includes('book'))  return 'book';
  if (name.includes('diamond'))       return 'diamond';
  if (name.includes('iron') || name.includes('skillet'))   return 'iron_ingot';
  if (name.includes('honey') || name.includes('golden'))   return 'honey_bottle';
  if (name.includes('wool') || name.includes('blanket'))   return 'white_wool';
  if (name.includes('clock') || name.includes('watch'))    return 'clock';
  if (name.includes('compass'))       return 'compass';
  if (name.includes('map'))           return 'map';
  if (name.includes('bow'))           return 'bow';
  if (name.includes('arrow'))         return 'arrow';
  if (name.includes('shield'))        return 'shield';
  if (name.includes('candle'))        return 'candle';
  if (name.includes('chain') || name.includes('necklace')) return 'chain';
  if (name.includes('glass') || name.includes('bottle'))   return 'glass_bottle';
  if (name.includes('string') || name.includes('rope'))    return 'string';
  if (name.includes('paper'))         return 'paper';
  if (name.includes('painting'))      return 'painting';
  if (name.includes('chicken'))       return 'cooked_chicken';
  if (name.includes('beef') || name.includes('steak') || name.includes('burger')) return 'cooked_beef';
  if (name.includes('bread') || name.includes('sandwich')) return 'bread';
  if (name.includes('cookie') || name.includes('snack'))   return 'cookie';
  if (name.includes('cake'))          return 'cake';
  if (name.includes('fish') || name.includes('sushi'))     return 'cooked_cod';
  if (name.includes('carrot') || name.includes('vegeta'))  return 'carrot';
  if (name.includes('potato') || name.includes('fries'))   return 'baked_potato';
  if (name.includes('egg'))           return 'egg';
  if (name.includes('milk'))          return 'milk_bucket';
  if (name.includes('sugar') || name.includes('candy'))    return 'sugar';
  if (name.includes('pork') || name.includes('bacon'))     return 'cooked_porkchop';
  return 'chest';
}

function parseProducts(transaction: any): { name: string; mcItem: string; qty: number }[] {
  if (!transaction?.products || !Array.isArray(transaction.products)) return [];
  return transaction.products.map((p: any) => ({
    name: p.name || 'Unknown Item',
    mcItem: mapProductToMinecraft(p.name || ''),
    qty: p.quantity || 1,
  }));
}

// ============================================
// Fetch orders from Knot, fall back to seed data
// ============================================

async function getOrderProducts(): Promise<{ name: string; mcItem: string; qty: number }[]> {
  // Try to pull real transactions from Knot
  try {
    const sessionId = await createSession();
    const merchants = await listMerchants();
    console.log(`[KNOT] ${merchants.length} merchants available for TransactionLink`);

    if (sessionId) {
      const transactions = await syncTransactions(sessionId);
      if (transactions.length > 0) {
        const products = parseProducts(transactions[0]);
        if (products.length > 0) {
          console.log(`[KNOT] Got ${products.length} real products from transaction`);
          return products;
        }
      }
    }
  } catch (err: any) {
    console.log(`[KNOT] API error: ${err.message}`);
  }

  // No linked account yet — use seed data for development
  console.log('[KNOT] No linked account, using seed transactions');
  const seed = getSeedTransactions();
  const txn = seed[Math.floor(Math.random() * seed.length)];
  console.log(`[KNOT] Seed order ${txn.external_id}: $${txn.price.total}`);
  return parseProducts(txn);
}

// ============================================
// Delivery sequence
// ============================================

async function triggerDelivery(products: { name: string; mcItem: string; qty: number }[]) {
  if (!bot || !botReady) {
    console.error('[DELIVERY] Bot not ready');
    return;
  }
  if (deliveryInProgress) {
    console.log('[DELIVERY] Delivery already in progress');
    return;
  }

  deliveryInProgress = true;

  try {
    const playerPos = await getPlayerPosition();
    console.log(`[DELIVERY] Player at ${formatPos(playerPos)}`);

    const spawnPos = await teleportDriverNear(playerPos);

    await clearBotInventory();
    await giveItemToBot('chest', 1);
    await equipItemInHand('chest');
    await sleep(2000);

    await followPlayerForDelivery();

    await sleep(500);
    await lookAtPlayer().catch(() => {});
    bot.chat(`Amazon delivery for ${PLAYER_NAME}!`);
    await sleep(500);
    await tossItemToPlayer('chest', 1, 'package');

    for (const p of products) {
      bot.chat(`  ${p.name} x${p.qty}`);
      await tossItemToPlayer(p.mcItem, p.qty, p.name);
    }

    await sleep(500);
    bot.chat('Have a great day!');

    await sleep(1500);
    bot.pathfinder.setGoal(new goals.GoalNear(spawnPos.x, spawnPos.y, spawnPos.z, 2));
    await waitForGoal(spawnPos);
    console.log('[DELIVERY] Complete');
  } catch (err: any) {
    console.error(`[DELIVERY] Failed: ${err.message}`);
  } finally {
    deliveryInProgress = false;
  }
}

// ============================================
// Routes
// ============================================

app.post('/webhook/knot', async (req, res) => {
  console.log('[WEBHOOK] Knot event received');
  const products = await getOrderProducts();
  triggerDelivery(products);
  res.status(200).json({ received: true, products });
});

app.post('/deliver', async (req, res) => {
  console.log('[DELIVER] Trigger');
  const products = await getOrderProducts();
  triggerDelivery(products);
  res.status(200).json({ delivered: true, products });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    botReady,
    botUsername: BOT_USERNAME,
    botAuth: BOT_AUTH,
    host: MC_HOST,
    port: MC_PORT,
    playerName: PLAYER_NAME,
    connectionAttempts,
    isConnecting,
    lastDisconnectReason,
  });
});

// ============================================
// Start
// ============================================

const PORT = parseInt(process.env.WEBHOOK_PORT || '3001');

app.listen(PORT, () => {
  console.log(`[SERVER] Running on :${PORT}`);
  console.log(`[SERVER] Demo: curl -X POST http://localhost:${PORT}/deliver`);
  console.log(`[SERVER] Bot config: username=${BOT_USERNAME}, auth=${BOT_AUTH}, host=${MC_HOST}, port=${MC_PORT}${MC_VERSION ? `, version=${MC_VERSION}` : ''}`);
  createDeliveryBot();
});
