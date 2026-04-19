import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function fetchJson(url, timeoutMs = 1500) {
const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_JOIN_DELAYS_MS = Object.freeze({
  "worker-builder": 0,
  "worker-forager": 60000,
  "worker-miner": 120000,
});

function simulationResult(taskBrief) {
  const kind = taskBrief.kind;
  const target = taskBrief.target || "area";
  const quantity = taskBrief.quantity || (kind === "expand_storage" ? 1 : 8);
  const inventoryDelta = {};
  if (kind === "mine_ore") inventoryDelta[target] = quantity;
  if (kind === "gather_food") inventoryDelta.cooked_food = quantity;
  if (kind === "expand_storage") inventoryDelta.empty_storage_slots = 54;
  if (kind === "build_base") inventoryDelta.base_progress = 1;
  if (kind === "craft_tools") inventoryDelta[target || "pickaxe"] = quantity;
  if (kind === "craft_torches") inventoryDelta.torch = quantity;
  if (kind === "gather_wood") inventoryDelta[target || "oak_log"] = quantity;
  if (kind === "gather_stone") inventoryDelta[target || "cobblestone"] = quantity;
  return {
    success: true,
    mode: "simulation",
    summary: `Simulated ${kind} for ${target}`,
    inventory_delta: inventoryDelta,
    observations: [
      { memory_type: "observation", content: { text: `Completed ${kind}`, target, quantity } },
    ],
  };
}

export class VoyagerAdapter {
  constructor({ voyagerPath, pythonPath = "python3", ckptDir = null, minecraft = {}, simulationMode = true, workerId = "worker", logger }) {
    this.voyagerPath = voyagerPath;
    this.pythonPath = pythonPath;
    this.ckptDir = ckptDir;
    this.minecraft = minecraft;
    this.simulationMode = simulationMode || !voyagerPath;
    this.workerId = workerId;
    this.logger = logger;
    this.currentProcess = null;
    this.connectionProcess = null;
  }

  getConfigProblems() {
    const reasons = [];
    if (!this.voyagerPath) reasons.push("VOYAGER_PATH is not set");
    if (this.simulationMode) reasons.push("VOYAGER_SIMULATION_MODE is enabled");
    if (!this.minecraft.host) reasons.push("VOYAGER_MC_HOST is not set");
    return reasons;
  }

  getStartupJoinDelayMs() {
    if (this.simulationMode) return 0;
    const explicit = Number.parseInt(process.env.VOYAGER_JOIN_DELAY_MS || "", 10);
    if (Number.isFinite(explicit) && explicit >= 0) return explicit;
    return DEFAULT_JOIN_DELAYS_MS[this.workerId] || 0;
  }

  async getMinecraftReadiness() {
    const reasons = this.getConfigProblems();
    const bridgeStatus = reasons.length === 0 ? await this.getBridgeStatus() : null;
    if (reasons.length === 0 && !bridgeStatus) {
      reasons.push("Mineflayer bridge is not listening");
    } else if (bridgeStatus && !bridgeStatus.connected) {
      reasons.push(bridgeStatus.lastDisconnect || bridgeStatus.lastError || "Mineflayer bot has not spawned in Minecraft");
    }
    return {
      ready: reasons.length === 0,
      reasons,
      mode: this.simulationMode ? "simulation" : "real",
      busy: Boolean(this.currentProcess),
      connected: Boolean(bridgeStatus?.connected),
      bridge: bridgeStatus,
      voyagerPath: this.voyagerPath,
      minecraft: {
        host: this.minecraft.host || null,
        port: this.minecraft.port || null,
        serverPort: this.minecraft.serverPort || null,
        botUsername: this.minecraft.botUsername || null,
      },
    };
  }

  async getBridgeStatus() {
    if (!this.minecraft.serverPort) return null;
    return fetchJson(`http://127.0.0.1:${this.minecraft.serverPort}/status`);
  }

  async ensureConnected() {
    const configProblems = this.getConfigProblems();
    if (configProblems.length > 0 || this.currentProcess || this.connectionProcess) {
      return this.getMinecraftReadiness();
    }

    const ckptDirLiteral = this.ckptDir ? JSON.stringify(this.ckptDir) : "None";
    const script = [
      "import os, sys, time",
      `sys.path.insert(0, ${JSON.stringify(this.voyagerPath)})`,
      "from voyager import Voyager",
      `worker_id = ${JSON.stringify(this.workerId)}`,
      `default_ckpt = os.path.join(os.getcwd(), "ckpt", worker_id)`,
      `ckpt_dir = ${ckptDirLiteral} or os.getenv("VOYAGER_CKPT_DIR") or default_ckpt`,
      "mc_port = int(os.getenv('VOYAGER_MC_PORT')) if os.getenv('VOYAGER_MC_PORT') else None",
      "server_port = int(os.getenv('VOYAGER_SERVER_PORT', '3000'))",
      "print('[VOYAGER] Keeping idle connection open', flush=True)",
      "voyager = Voyager(",
      "    mc_host=os.getenv('VOYAGER_MC_HOST'),",
      "    mc_port=mc_port,",
      "    server_port=server_port,",
      "    bot_username=os.getenv('VOYAGER_BOT_USERNAME', 'bot'),",
      "    mc_auth=os.getenv('VOYAGER_MC_AUTH', 'offline'),",
      "    mc_version=os.getenv('VOYAGER_MC_VERSION'),",
      "    ckpt_dir=ckpt_dir,",
      "    resume=False,",
      ")",
      "voyager.env.reset(options={'mode': 'soft', 'wait_ticks': 5})",
      "print('[VOYAGER] Idle connection ready', flush=True)",
      "while True:",
      "    time.sleep(60)",
    ].join("\n");
    const tempFile = path.join(os.tmpdir(), `openclaw-voyager-idle-${this.workerId}-${Date.now()}.py`);
    await fs.writeFile(tempFile, script);

    const connectionProcess = spawn(this.pythonPath, [tempFile], {
      cwd: this.voyagerPath,
      env: this.buildVoyagerEnv(),
    });
    this.connectionProcess = connectionProcess;
    connectionProcess.stdout.on("data", (data) => {
      this.logger?.info("Voyager idle output", { workerId: this.workerId, text: data.toString().trim() });
    });
    connectionProcess.stderr.on("data", (data) => {
      this.logger?.warn("Voyager idle stderr", { workerId: this.workerId, text: data.toString().trim() });
    });
    connectionProcess.on("close", async (code) => {
      await fs.rm(tempFile, { force: true });
      if (this.connectionProcess === connectionProcess) this.connectionProcess = null;
      this.logger?.info("Voyager idle connection closed", { workerId: this.workerId, code });
    });

    return this.getMinecraftReadiness();
  }

  async stopIdleConnection() {
    if (!this.connectionProcess) return;
    const processToStop = this.connectionProcess;
    this.connectionProcess = null;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (!processToStop.killed) processToStop.kill("SIGKILL");
        resolve();
      }, 3000);
      processToStop.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      processToStop.kill("SIGTERM");
    });
  }

  async executeTask(taskBrief) {
    if (this.simulationMode) return simulationResult(taskBrief);
    await this.stopIdleConnection();
    const ckptDirLiteral = this.ckptDir ? JSON.stringify(this.ckptDir) : "None";
    const subGoals = Array.isArray(taskBrief.voyager_sub_goals) ? taskBrief.voyager_sub_goals : [];
    const script = [
      "import os, sys, json",
      `sys.path.insert(0, ${JSON.stringify(this.voyagerPath)})`,
      "from voyager import Voyager",
      `task = ${JSON.stringify(taskBrief.objective)}`,
      `sub_goals = ${JSON.stringify(subGoals)}`,
      `worker_id = ${JSON.stringify(this.workerId)}`,
      `default_ckpt = os.path.join(os.getcwd(), "ckpt", worker_id)`,
      `ckpt_dir = ${ckptDirLiteral} or os.getenv("VOYAGER_CKPT_DIR") or default_ckpt`,
      "mc_port = int(os.getenv('VOYAGER_MC_PORT')) if os.getenv('VOYAGER_MC_PORT') else None",
      "server_port = int(os.getenv('VOYAGER_SERVER_PORT', '3000'))",
      "print('[VOYAGER] Initializing')",
      "voyager = Voyager(",
      "    mc_host=os.getenv('VOYAGER_MC_HOST'),",
      "    mc_port=mc_port,",
      "    server_port=server_port,",
      "    bot_username=os.getenv('VOYAGER_BOT_USERNAME', 'bot'),",
      "    mc_auth=os.getenv('VOYAGER_MC_AUTH', 'offline'),",
      "    mc_version=os.getenv('VOYAGER_MC_VERSION'),",
      "    ckpt_dir=ckpt_dir,",
      "    resume=False,",
      ")",
      "print('[VOYAGER] Executing task: ' + task)",
      "if sub_goals:",
      "    print('[VOYAGER] Using explicit sub_goals: ' + json.dumps(sub_goals))",
      "    voyager.inference(sub_goals=sub_goals)",
      "else:",
      "    voyager.inference(task=task)",
      "print(json.dumps({'success': True, 'summary': 'Voyager completed task'}))",
    ].join("\n");
    const tempFile = path.join(os.tmpdir(), `openclaw-voyager-${Date.now()}.py`);
    await fs.writeFile(tempFile, script);

    return new Promise((resolve, reject) => {
      this.currentProcess = spawn(this.pythonPath, [tempFile], {
        cwd: this.voyagerPath,
        env: this.buildVoyagerEnv(),
      });
      let stdout = "";
      let stderr = "";
      this.currentProcess.stdout.on("data", (data) => {
        stdout += data.toString();
        this.logger?.info("Voyager output", { text: data.toString().trim() });
      });
      this.currentProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      this.currentProcess.on("close", async (code) => {
        await fs.rm(tempFile, { force: true });
        this.currentProcess = null;
        this.ensureConnected().catch((error) => {
          this.logger?.warn("Failed to restart Voyager idle connection", { workerId: this.workerId, error: error.message });
        });
        if (code !== 0) {
          reject(new Error(`Voyager failed with code ${code}: ${stderr}`));
          return;
        }
        resolve({ success: true, mode: "real", summary: stdout.trim(), raw_output: stdout });
      });
    });
  }

  async cancelTask() {
    if (this.currentProcess) this.currentProcess.kill("SIGTERM");
  }

  async getLocalStatus() {
    return { mode: this.simulationMode ? "simulation" : "real", busy: Boolean(this.currentProcess), voyagerPath: this.voyagerPath };
  }

  buildVoyagerEnv() {
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      WORKER_ID: this.workerId,
    };
    if (this.minecraft.host) env.VOYAGER_MC_HOST = this.minecraft.host;
    if (this.minecraft.port) env.VOYAGER_MC_PORT = String(this.minecraft.port);
    if (this.minecraft.serverPort) env.VOYAGER_SERVER_PORT = String(this.minecraft.serverPort);
    if (this.minecraft.botUsername) env.VOYAGER_BOT_USERNAME = this.minecraft.botUsername;
    if (this.ckptDir) env.VOYAGER_CKPT_DIR = this.ckptDir;
    return env;
  }
}
