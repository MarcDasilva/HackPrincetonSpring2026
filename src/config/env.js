import dotenv from "dotenv";
import { z } from "zod";
import { WORKER_IDS } from "../shared/constants.js";

const DEFAULT_WORKER_MINECRAFT = Object.freeze({
  "worker-miner": { serverPort: 3011, botUsername: "miner_bot" },
  "worker-builder": { serverPort: 3012, botUsername: "builder_bot" },
  "worker-forager": { serverPort: 3013, botUsername: "forager_bot" },
});

dotenv.config();

const boolFromEnv = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const intFromEnv = (value, defaultValue) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

const nullableString = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
};

const listFromEnv = (...values) => values
  .flatMap((value) => String(value || "").split(","))
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value, index, all) => all.indexOf(value) === index);

const envSchema = z.object({
  photon: z.object({
    apiKey: z.string().nullable(),
    projectId: z.string().nullable(),
    projectSecret: z.string().nullable(),
    mode: z.enum(["local", "cloud", "simulation"]).default("local"),
    groupId: z.string().nullable(),
    dmAllowedSenders: z.array(z.string()).default([]),
    selfIdentifier: z.string().nullable(),
  }),
  supabase: z.object({
    url: z.string().nullable(),
    serviceRoleKey: z.string().nullable(),
    anonKey: z.string().nullable(),
  }),
  openclaw: z.object({
    fakeMode: z.boolean(),
    foreman: z.object({ url: z.string().nullable(), token: z.string().nullable() }),
    workers: z.record(z.object({ url: z.string().nullable(), token: z.string().nullable() })),
  }),
  voyager: z.object({
    path: z.string().nullable(),
    pythonPath: z.string(),
    ckptDir: z.string().nullable(),
    mcHost: z.string().nullable(),
    mcPort: z.number().int().positive().nullable(),
    serverPort: z.number().int().positive().nullable(),
    botUsername: z.string().nullable(),
    workers: z.record(z.object({
      mcHost: z.string().nullable(),
      mcPort: z.number().int().positive().nullable(),
      serverPort: z.number().int().positive(),
      botUsername: z.string(),
    })),
    simulationMode: z.boolean(),
  }),
  dedalus: z.object({
    apiKey: z.string().nullable(),
    controlMachineId: z.string().nullable(),
    workerMachineIds: z.record(z.string().nullable()),
  }),
  workerId: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  fallbackPollingMs: z.number().int().positive(),
  stuckTimeoutMs: z.number().int().positive(),
  simulationDbPath: z.string(),
  logLevel: z.string(),
});

export function loadEnv(raw = process.env) {
  const workerMinecraft = Object.fromEntries(WORKER_IDS.map((workerId) => {
    const prefix = workerId.toUpperCase().replaceAll("-", "_");
    const defaults = DEFAULT_WORKER_MINECRAFT[workerId];
    return [workerId, {
      mcHost: nullableString(raw[`VOYAGER_${prefix}_MC_HOST`] || raw.VOYAGER_MC_HOST),
      mcPort: raw[`VOYAGER_${prefix}_MC_PORT`]
        ? intFromEnv(raw[`VOYAGER_${prefix}_MC_PORT`], 25565)
        : (raw.VOYAGER_MC_PORT ? intFromEnv(raw.VOYAGER_MC_PORT, 25565) : null),
      serverPort: raw[`VOYAGER_${prefix}_SERVER_PORT`]
        ? intFromEnv(raw[`VOYAGER_${prefix}_SERVER_PORT`], defaults.serverPort)
        : defaults.serverPort,
      botUsername: nullableString(raw[`VOYAGER_${prefix}_BOT_USERNAME`] || defaults.botUsername),
    }];
  }));

  const config = {
    photon: {
      apiKey: nullableString(raw.PHOTON_API_KEY),
      projectId: nullableString(raw.PHOTON_PROJECT_ID),
      projectSecret: nullableString(raw.PHOTON_PROJECT_SECRET),
      mode: raw.PHOTON_MODE || "local",
      groupId: nullableString(raw.IMESSAGE_GROUP_ID),
      dmAllowedSenders: listFromEnv(
        raw.IMESSAGE_ALLOWED_DM_SENDERS,
        raw.PHOTON_ALLOWED_DM_SENDERS,
        raw.USER_IMESSAGE_HANDLE,
      ),
      selfIdentifier: nullableString(raw.PHOTON_SELF_IDENTIFIER),
    },
    supabase: {
      url: nullableString(raw.SUPABASE_URL),
      serviceRoleKey: nullableString(raw.SUPABASE_SERVICE_ROLE_KEY || raw.SUPABASE_KEY),
      anonKey: nullableString(raw.SUPABASE_ANON_KEY),
    },
    openclaw: {
      fakeMode: boolFromEnv(raw.OPENCLAW_FAKE_MODE, false),
      foreman: {
        url: nullableString(raw.FOREMAN_OPENCLAW_URL),
        token: nullableString(raw.FOREMAN_OPENCLAW_TOKEN),
      },
      workers: {
        "worker-miner": {
          url: nullableString(raw.WORKER_MINER_OPENCLAW_URL),
          token: nullableString(raw.WORKER_MINER_OPENCLAW_TOKEN),
        },
        "worker-builder": {
          url: nullableString(raw.WORKER_BUILDER_OPENCLAW_URL),
          token: nullableString(raw.WORKER_BUILDER_OPENCLAW_TOKEN),
        },
        "worker-forager": {
          url: nullableString(raw.WORKER_FORAGER_OPENCLAW_URL),
          token: nullableString(raw.WORKER_FORAGER_OPENCLAW_TOKEN),
        },
      },
    },
    voyager: {
      path: nullableString(raw.VOYAGER_PATH),
      pythonPath: raw.VOYAGER_PYTHON || "python3",
      ckptDir: nullableString(raw.VOYAGER_CKPT_DIR),
      mcHost: nullableString(raw.VOYAGER_MC_HOST),
      mcPort: raw.VOYAGER_MC_PORT ? intFromEnv(raw.VOYAGER_MC_PORT, 25565) : null,
      serverPort: raw.VOYAGER_SERVER_PORT ? intFromEnv(raw.VOYAGER_SERVER_PORT, 3000) : null,
      botUsername: nullableString(raw.VOYAGER_BOT_USERNAME),
      workers: workerMinecraft,
      simulationMode: boolFromEnv(raw.VOYAGER_SIMULATION_MODE, true),
    },
    dedalus: {
      apiKey: nullableString(raw.DEDALUS_API_KEY),
      controlMachineId: nullableString(raw.DEDALUS_CONTROL_MACHINE_ID),
      workerMachineIds: {
        "worker-miner": nullableString(raw.DEDALUS_WORKER_MINER_MACHINE_ID),
        "worker-builder": nullableString(raw.DEDALUS_WORKER_BUILDER_MACHINE_ID),
        "worker-forager": nullableString(raw.DEDALUS_WORKER_FORAGER_MACHINE_ID),
      },
    },
    workerId: raw.WORKER_ID || "worker-miner",
    heartbeatIntervalMs: intFromEnv(raw.HEARTBEAT_INTERVAL_MS, 5000),
    fallbackPollingMs: intFromEnv(raw.FALLBACK_POLLING_MS, 5000),
    stuckTimeoutMs: intFromEnv(raw.STUCK_TIMEOUT_MS, 600000),
    simulationDbPath: raw.SIMULATION_DB_PATH || ".simulation/openclaw-state.json",
    logLevel: raw.LOG_LEVEL || "info",
  };

  return envSchema.parse(config);
}

export function assertServiceEnv(config, serviceName) {
  if (serviceName === "supabase" && (!config.supabase.url || !config.supabase.serviceRoleKey)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase-backed services.");
  }
  if (
    serviceName === "photon" &&
    config.photon.mode !== "simulation" &&
    !config.photon.groupId &&
    config.photon.dmAllowedSenders.length === 0
  ) {
    throw new Error("IMESSAGE_GROUP_ID or IMESSAGE_ALLOWED_DM_SENDERS is required for the Photon bridge outside simulation mode.");
  }
  if (serviceName === "photon" && config.photon.mode === "cloud" && (!config.photon.projectId || !config.photon.projectSecret)) {
    throw new Error("PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are required when PHOTON_MODE=cloud.");
  }
  if (serviceName === "worker" && !WORKER_IDS.includes(config.workerId)) {
    throw new Error(`WORKER_ID must be one of: ${WORKER_IDS.join(", ")}`);
  }
}

export function getWorkerOpenClawConfig(config, workerId) {
  const target = config.openclaw.workers[workerId];
  if (!target) throw new Error(`No OpenClaw target configured for worker ${workerId}`);
  return target;
}
