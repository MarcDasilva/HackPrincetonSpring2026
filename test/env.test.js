import test from "node:test";
import assert from "node:assert/strict";
import { assertServiceEnv, loadEnv } from "../src/config/env.js";

test("loadEnv applies simulation-safe defaults", () => {
  const config = loadEnv({});
  assert.equal(config.workerId, "worker-miner");
  assert.equal(config.voyager.simulationMode, true);
  assert.equal(config.photon.mode, "local");
});

test("loadEnv accepts persistent-memory orchestration env", () => {
  const config = loadEnv({
    PHOTON_MODE: "simulation",
    PHOTON_PROJECT_ID: "project-id",
    PHOTON_PROJECT_SECRET: "project-secret",
    OPENCLAW_FAKE_MODE: "true",
    WORKER_ID: "worker-builder",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  });
  assert.equal(config.openclaw.fakeMode, true);
  assert.equal(config.workerId, "worker-builder");
  assert.equal(config.supabase.serviceRoleKey, "service-role");
  assert.equal(config.photon.projectId, "project-id");
  assert.equal(config.photon.projectSecret, "project-secret");
});

test("loadEnv accepts a DM sender allowlist for Photon", () => {
  const config = loadEnv({
    IMESSAGE_ALLOWED_DM_SENDERS: "+15551234567, user@example.com",
  });
  assert.deepEqual(config.photon.dmAllowedSenders, ["+15551234567", "user@example.com"]);
  assert.doesNotThrow(() => assertServiceEnv(config, "photon"));
});

test("loadEnv gives each worker a distinct Minecraft body", () => {
  const config = loadEnv({
    VOYAGER_MC_HOST: "example.org",
    VOYAGER_MC_PORT: "25565",
    VOYAGER_WORKER_BUILDER_BOT_USERNAME: "custom_builder",
    VOYAGER_WORKER_BUILDER_SERVER_PORT: "4012",
  });
  assert.deepEqual(config.voyager.workers["worker-miner"], {
    mcHost: "example.org",
    mcPort: 25565,
    serverPort: 3011,
    botUsername: "miner_bot",
  });
  assert.deepEqual(config.voyager.workers["worker-builder"], {
    mcHost: "example.org",
    mcPort: 25565,
    serverPort: 4012,
    botUsername: "custom_builder",
  });
  assert.deepEqual(config.voyager.workers["worker-forager"], {
    mcHost: "example.org",
    mcPort: 25565,
    serverPort: 3013,
    botUsername: "forager_bot",
  });
});
