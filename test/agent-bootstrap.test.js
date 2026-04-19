import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadAgentBootstrap } from "../src/lib/agent-bootstrap.js";
import { buildWorkerClaimPrompt } from "../src/worker/worker-prompts.js";

function withBootstrapDir(files, run) {
  const previous = process.env.OPENCLAW_AGENT_BOOTSTRAP_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-bootstrap-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(root, name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  process.env.OPENCLAW_AGENT_BOOTSTRAP_DIR = root;
  try {
    run(root);
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_AGENT_BOOTSTRAP_DIR;
    else process.env.OPENCLAW_AGENT_BOOTSTRAP_DIR = previous;
  }
}

test("loadAgentBootstrap merges shared and worker-specific markdown", () => {
  withBootstrapDir({
    "shared/AGENTS.md": "Shared rules.",
    "worker-miner/SOUL.md": "Miner identity.",
    "worker-builder/SOUL.md": "Builder identity.",
  }, () => {
    const miner = loadAgentBootstrap("worker-miner");
    assert.match(miner, /Shared rules/);
    assert.match(miner, /Miner identity/);
    assert.doesNotMatch(miner, /Builder identity/);
  });
});

test("worker prompts include the selected agent bootstrap", () => {
  withBootstrapDir({
    "shared/AGENTS.md": "Do not invent facts.",
    "worker-forager/SOUL.md": "Forager identity.",
  }, () => {
    const messages = buildWorkerClaimPrompt("worker-forager", {
      objective: "Gather food",
    });
    assert.match(messages[0].content, /Do not invent facts/);
    assert.match(messages[0].content, /Forager identity/);
  });
});
