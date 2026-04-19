import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/config/env.js";
import { MESSAGE_DIRECTION } from "../src/shared/constants.js";
import { PhotonBridge, isAllowedDirectSender, queueOutboundMessage } from "../src/lib/photon-bridge.js";
import { SimulationStore } from "../src/lib/simulation-store.js";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function dmMessage(patch = {}) {
  return {
    id: "dm-1",
    chatId: "iMessage;-;+15551234567",
    chatKind: "dm",
    participant: "+1 (555) 123-4567",
    text: "mine a safe path to diamonds",
    kind: "text",
    isFromMe: false,
    ...patch,
  };
}

test("isAllowedDirectSender matches phone formatting and DM chat ids", () => {
  const allowlist = ["+15551234567"];
  assert.equal(isAllowedDirectSender("+1 (555) 123-4567", allowlist), true);
  assert.equal(isAllowedDirectSender("iMessage;-;+15551234567", allowlist), true);
  assert.equal(isAllowedDirectSender("+15557654321", allowlist), false);
});

test("Photon local bridge ingests allowlisted direct messages", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  const config = loadEnv({ IMESSAGE_ALLOWED_DM_SENDERS: "+15551234567" });
  const bridge = new PhotonBridge({ config, store, logger });

  await bridge.handleLocalDirectMessage(dmMessage());

  const inbound = await store.listChatMessages({ direction: MESSAGE_DIRECTION.inbound });
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].source_chat, "any;-;+15551234567");
  assert.equal(inbound[0].metadata.channel, "dm");
  assert.equal(inbound[0].content, "mine a safe path to diamonds");
});

test("Photon local bridge ignores direct messages outside the allowlist", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  const config = loadEnv({ IMESSAGE_ALLOWED_DM_SENDERS: "+15551234567" });
  const bridge = new PhotonBridge({ config, store, logger });

  await bridge.handleLocalDirectMessage(dmMessage({
    id: "dm-2",
    chatId: "iMessage;-;+15557654321",
    participant: "+15557654321",
  }));

  const inbound = await store.listChatMessages({ direction: MESSAGE_DIRECTION.inbound });
  assert.equal(inbound.length, 0);
});

test("Photon outbound replies can fall back to a DM source chat", async () => {
  const store = new SimulationStore({ persist: false });
  await store.load();
  const config = loadEnv({ IMESSAGE_ALLOWED_DM_SENDERS: "+15551234567" });
  const bridge = new PhotonBridge({ config, store, logger });
  const sent = [];
  const app = {
    send: async (target, content) => {
      sent.push({ target, content });
    },
  };

  await queueOutboundMessage(store, {
    speakerAgentId: "foreman",
    body: "Foreman: on it.",
    sourceChat: "iMessage;-;+15551234567",
    metadata: { channel: "dm" },
  });
  await bridge.flushOutbound(app);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, "any;-;+15551234567");
  assert.equal(sent[0].content.text, "Foreman: on it.");
});
