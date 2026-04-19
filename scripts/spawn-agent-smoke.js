import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const REPO_ROOT = "/Users/marc/Voyager-1";
const MC_HOST = process.env.VOYAGER_MC_HOST || "127.0.0.1";
const MC_PORT = parseInt(process.env.VOYAGER_MC_PORT || "25565", 10);
const BASE_SERVER_PORT = parseInt(process.env.VOYAGER_SERVER_PORT || "3000", 10);

function isExecutableFile(candidatePath) {
  try {
    return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile();
  } catch (error) {
    return false;
  }
}

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
  for (const candidate of candidates) {
    if (!candidate.includes("/")) return candidate;
    if (isExecutableFile(candidate)) return candidate;
  }
  return "python3";
}

function isTcpReachable(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (error) {}
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function findAvailablePort(startPort, maxScan = 200) {
  for (let offset = 0; offset < maxScan; offset += 1) {
    const candidate = startPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(candidate);
    if (free) return candidate;
  }
  throw new Error(`No available bridge port from ${startPort} after ${maxScan} scans.`);
}

async function main() {
  const pythonBin = resolvePythonBin();
  const bridgePort = await findAvailablePort(BASE_SERVER_PORT);
  const mcReachable = await isTcpReachable(MC_HOST, MC_PORT);

  console.log(`[SPAWN] Repo root: ${REPO_ROOT}`);
  console.log(`[SPAWN] Python: ${pythonBin}`);
  console.log(`[SPAWN] Minecraft target: ${MC_HOST}:${MC_PORT} (reachable=${mcReachable})`);
  console.log(`[SPAWN] Bridge port: ${bridgePort}`);

  if (!mcReachable) {
    throw new Error(
      `Minecraft server is unreachable at ${MC_HOST}:${MC_PORT}. Open your world to LAN and retry.`
    );
  }

  const ckptDir = path.join(REPO_ROOT, "ckpt-spawn-smoke");
  fs.mkdirSync(ckptDir, { recursive: true });
  const tempPy = path.join(os.tmpdir(), `voyager-spawn-smoke-${Date.now()}.py`);

  const pyScript = [
    "import os",
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(REPO_ROOT)})`,
    "from voyager import Voyager",
    "print('[SPAWN] Voyager import OK')",
    "voyager = Voyager(",
    `  mc_host=${JSON.stringify(MC_HOST)},`,
    `  mc_port=${MC_PORT},`,
    `  server_port=${bridgePort},`,
    "  bot_username='spawn_smoke_bot',",
    `  openai_api_key=${JSON.stringify(process.env.OPENAI_API_KEY || "")},`,
    `  ckpt_dir=${JSON.stringify(ckptDir)},`,
    "  resume=False,",
    ")",
    "print('[SPAWN] Voyager init OK')",
    "voyager.reset(task='collect 1 dirt block', context='spawn smoke', reset_env=True)",
    "print('[SPAWN] Voyager reset OK (spawn verified)')",
    "voyager.close()",
    "print('[SPAWN] Voyager close OK')",
  ].join("\n");

  fs.writeFileSync(tempPy, pyScript);

  await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [tempPy], {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let stderr = "";
    child.stdout.on("data", (chunk) => process.stdout.write(chunk.toString()));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      try {
        fs.unlinkSync(tempPy);
      } catch (error) {}
      if (code === 0) resolve();
      else reject(new Error(`Spawn smoke failed with code ${code}. ${stderr.slice(-500)}`));
    });
  });
}

main().catch((error) => {
  console.error(`[SPAWN] FAIL: ${error.message}`);
  process.exit(1);
});
