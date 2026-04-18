import { MESSAGE_DIRECTION, MESSAGE_PROCESSING_STATUS, MESSAGE_TYPE, OUTBOUND_STATUS } from "../shared/constants.js";

export function parseChatShortcut(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "status") return { shortcut: "status", kind: "report_status" };
  if (lower === "inventory") return { shortcut: "inventory", kind: "inventory_check" };
  if (lower.startsWith("@all") && lower.includes("return")) return { shortcut: "return_all", kind: "return_to_base" };
  const mention = raw.match(/^@(miner|builder|forager)\s+(.+)/i);
  if (mention) return { shortcut: "worker_focus", preferred_worker_role: mention[1].toLowerCase(), text: mention[2] };
  return {};
}

export async function ingestInboundMessage(store, { sourceChat, sender, text }) {
  return store.insertChatMessage({
    sender,
    message_type: MESSAGE_TYPE.user,
    content: text,
    source_chat: sourceChat || "group_chat",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: { parsed_intent: parseChatShortcut(text) },
  });
}

export async function queueOutboundMessage(store, { speakerAgentId, body, metadata = {}, sourceChat = "group_chat" }) {
  return store.insertChatMessage({
    sender: speakerAgentId || "system",
    message_type: speakerAgentId ? MESSAGE_TYPE.agent : MESSAGE_TYPE.system,
    content: body,
    source_chat: sourceChat,
    direction: MESSAGE_DIRECTION.outbound,
    processing_status: MESSAGE_PROCESSING_STATUS.processed,
    delivery_status: OUTBOUND_STATUS.pending,
    metadata,
  });
}

export class PhotonBridge {
  constructor({ config, store, logger }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.seen = new Set();
    this.spaces = new Map();
  }

  async start() {
    if (this.config.photon.mode === "simulation") {
      this.logger.info("Photon bridge simulation mode; no iMessage listener started");
      return;
    }
    const [{ Spectrum }, { imessage }] = await Promise.all([
      import("spectrum-ts"),
      import("spectrum-ts/providers/imessage"),
    ]);
    const app = await Spectrum({
      ...(this.config.photon.apiKey ? { apiKey: this.config.photon.apiKey } : {}),
      providers: [imessage.config(this.config.photon.mode === "cloud" ? { mode: "cloud" } : { local: true })],
    });

    this.logger.info("Photon bridge connected", { mode: this.config.photon.mode });
    this.flushOutboundLoop(app).catch((error) => this.logger.error("Outbound loop failed", { error: error.message }));

    for await (const [space, message] of app.messages) {
      if (space?.id) this.spaces.set(space.id, space);
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (message.content?.type !== "text") continue;
      if (this.config.photon.selfIdentifier && message.sender?.id === this.config.photon.selfIdentifier) continue;
      if (this.config.photon.groupId && space.id !== this.config.photon.groupId) continue;
      await ingestInboundMessage(this.store, {
        sourceChat: space.id,
        sender: message.sender?.id || message.sender?.name || "unknown",
        text: message.content.text,
      });
    }
  }

  async flushOutboundLoop(app) {
    while (true) {
      await this.flushOutbound(app);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async flushOutbound(app) {
    const pending = await this.store.listChatMessages({ direction: MESSAGE_DIRECTION.outbound, delivery_status: OUTBOUND_STATUS.pending });
    for (const message of pending) {
      try {
        if (app) {
          const targetSpace = this.spaces.get(message.source_chat) || this.spaces.get(this.config.photon.groupId);
          if (!targetSpace) {
            this.logger.warn("Outbound message has no live Photon space yet", { id: message.id, source_chat: message.source_chat });
            continue;
          }
          await targetSpace.send(message.content);
        }
        await this.store.updateChatMessage(message.id, { delivery_status: OUTBOUND_STATUS.delivered, delivered_at: new Date().toISOString() });
      } catch (error) {
        await this.store.updateChatMessage(message.id, { delivery_status: OUTBOUND_STATUS.failed, metadata: { ...message.metadata, error: error.message } });
      }
    }
  }
}
