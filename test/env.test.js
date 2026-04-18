import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/config/env.js";

test("loadEnv applies simulation-safe defaults", () => {
  const config = loadEnv({});
  assert.equal(config.workerId, "worker-miner");
  assert.equal(config.voyager.simulationMode, true);
  assert.equal(config.photon.mode, "local");
});

test("loadEnv accepts persistent-memory orchestration env", () => {
  const config = loadEnv({
    PHOTON_MODE: "simulation",
    OPENCLAW_FAKE_MODE: "true",
    WORKER_ID: "worker-builder",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  });
  assert.equal(config.openclaw.fakeMode, true);
  assert.equal(config.workerId, "worker-builder");
  assert.equal(config.supabase.serviceRoleKey, "service-role");
});
