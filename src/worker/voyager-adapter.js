import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function simulationResult(taskBrief) {
  const kind = taskBrief.kind;
  const target = taskBrief.target || "area";
  const quantity = taskBrief.quantity || (kind === "expand_storage" ? 1 : 8);
  const inventoryDelta = {};
  if (kind === "mine_ore") inventoryDelta[target] = quantity;
  if (kind === "gather_food") inventoryDelta.cooked_food = quantity;
  if (kind === "expand_storage") inventoryDelta.empty_storage_slots = 54;
  if (kind === "craft_tools") inventoryDelta[target || "pickaxe"] = quantity;
  if (kind === "craft_torches") inventoryDelta.torch = quantity;
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
  }

  async executeTask(taskBrief) {
    if (this.simulationMode) return simulationResult(taskBrief);
    const script = [
      "import os, sys, json",
      `sys.path.insert(0, ${JSON.stringify(this.voyagerPath)})`,
      "from voyager import Voyager",
      `task = ${JSON.stringify(taskBrief.objective)}`,
      `worker_id = ${JSON.stringify(this.workerId)}`,
      `default_ckpt = os.path.join(os.getcwd(), "ckpt", worker_id)`,
      `ckpt_dir = ${JSON.stringify(this.ckptDir)} or os.getenv("VOYAGER_CKPT_DIR") or default_ckpt`,
      "print('[VOYAGER] Initializing')",
      "voyager = Voyager(ckpt_dir=ckpt_dir, resume=True)",
      "print('[VOYAGER] Executing task: ' + task)",
      "sub_goals = voyager.decompose_task(task=task)",
      "voyager.inference(sub_goals=sub_goals)",
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
