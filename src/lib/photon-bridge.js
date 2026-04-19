import {
  AGENT_IDS,
  MESSAGE_DIRECTION,
  MESSAGE_PROCESSING_STATUS,
  MESSAGE_TYPE,
  OUTBOUND_STATUS,
  WORKER_IDS,
} from "../shared/constants.js";

const ROLE_TO_WORKER_ID = Object.freeze({
  miner: AGENT_IDS.miner,
  builder: AGENT_IDS.builder,
  forager: AGENT_IDS.forager,
});

const NUMBER_TO_WORKER_ID = Object.freeze({
  "1": AGENT_IDS.miner,
  "2": AGENT_IDS.builder,
  "3": AGENT_IDS.forager,
});

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseWorkerTargets(rawTargets) {
  const normalized = String(rawTargets || "")
    .toLowerCase()
    .replaceAll("@", "")
    .replaceAll(",", " ")
    .split(/\s+/)
    .filter(Boolean);

  if (normalized.some((token) => ["all", "everyone", "everybody"].includes(token))) {
    return [...WORKER_IDS];
  }

  return uniq(normalized.map((token) => ROLE_TO_WORKER_ID[token] || NUMBER_TO_WORKER_ID[token]));
}

function isSpectrumGroupSpace(space, imessageProvider) {
  try {
    if (imessageProvider && space && imessageProvider(space)?.type) {
      return imessageProvider(space).type === "group";
    }
  } catch {}
  return space?.type === "group" || String(space?.id || "").includes(";+;") || String(space?.id || "").includes("group");
}

function dmRecipientFromChatId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/;-;(.+)$/);
  return (match ? match[1] : raw).replace(/^tel:/i, "");
}

function dmChatIdForRecipient(value) {
  const recipient = dmRecipientFromChatId(value);
  return recipient ? `any;-;${recipient}` : null;
}

function comparableHandles(value) {
  const handle = dmRecipientFromChatId(value).toLowerCase();
  const digits = handle.replace(/\D/g, "");
  return { handle, digits };
}

export function isAllowedDirectSender(sender, allowedSenders = []) {
  if (!sender || allowedSenders.length === 0) return false;
  const candidate = comparableHandles(sender);
  return allowedSenders.some((allowed) => {
    const expected = comparableHandles(allowed);
    if (candidate.handle === expected.handle) return true;
    if (!candidate.digits || !expected.digits) return false;
    if (candidate.digits === expected.digits) return true;
    return candidate.digits.length >= 7 &&
      expected.digits.length >= 7 &&
      (candidate.digits.endsWith(expected.digits) || expected.digits.endsWith(candidate.digits));
  });
}

export function parseChatShortcut(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();
  if (lower === "status") return { shortcut: "status", kind: "report_status" };
  if (lower === "inventory") return { shortcut: "inventory", kind: "inventory_check" };
  if (lower.startsWith("@all") && lower.includes("return")) return { shortcut: "return_all", kind: "return_to_base" };
  const mention = raw.match(/^@(miner|builder|forager)\s+(.+)/i);
  if (mention) {
    const preferredWorkerId = ROLE_TO_WORKER_ID[mention[1].toLowerCase()];
    return {
      shortcut: "worker_focus",
      preferred_worker_id: preferredWorkerId,
      preferred_worker_role: mention[1].toLowerCase(),
      target_worker_ids: [preferredWorkerId],
      text: mention[2],
    };
  }
  const allAgents = raw.match(/^(?:@all|all agents|everyone|everybody)\s+(.+)/i);
  if (allAgents) return { shortcut: "worker_group", target_worker_ids: [...WORKER_IDS], text: allAgents[1] };
  const numberedAgents = raw.match(/^(?:agents?|bots?)\s+([a-z0-9,\s]+?)\s+(.+)/i);
  if (numberedAgents) {
    const targetWorkerIds = parseWorkerTargets(numberedAgents[1]);
    if (targetWorkerIds.length > 0) {
      return {
        shortcut: targetWorkerIds.length === 1 ? "worker_focus" : "worker_group",
        preferred_worker_id: targetWorkerIds.length === 1 ? targetWorkerIds[0] : null,
        target_worker_ids: targetWorkerIds,
        text: numberedAgents[2],
      };
    }
  }
  return {};
}

export async function ingestInboundMessage(store, { sourceChat, sender, text, metadata = {} }) {
  return store.insertChatMessage({
    sender,
    message_type: MESSAGE_TYPE.user,
    content: text,
    source_chat: sourceChat || "group_chat",
    direction: MESSAGE_DIRECTION.inbound,
    processing_status: MESSAGE_PROCESSING_STATUS.new,
    delivery_status: OUTBOUND_STATUS.skipped,
    metadata: { ...metadata, parsed_intent: parseChatShortcut(text) },
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

    if (this.config.photon.mode === "local") {
      await this.startLocalBridge();
      return;
    }

    const [{ Spectrum }, { imessage }] = await Promise.all([
      import("spectrum-ts"),
      import("spectrum-ts/providers/imessage"),
    ]);
    const app = await Spectrum({
      ...(this.config.photon.mode === "cloud"
        ? {
            projectId: this.config.photon.projectId,
            projectSecret: this.config.photon.projectSecret,
          }
        : {}),
      providers: [imessage.config(this.config.photon.mode === "cloud" ? {} : { local: true })],
    });

    this.logger.info("Photon bridge connected", { mode: this.config.photon.mode });
    this.flushOutboundLoop(app).catch((error) => this.logger.error("Outbound loop failed", { error: error.message }));

    for await (const [space, message] of app.messages) {
      if (space?.id) this.spaces.set(space.id, space);
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (message.content?.type !== "text") continue;
      if (message.sender?.id === "") continue;
      const sender = message.sender?.id || message.sender?.name || "unknown";
      if (this.config.photon.selfIdentifier && isAllowedDirectSender(sender, [this.config.photon.selfIdentifier])) continue;
      const isGroup = isSpectrumGroupSpace(space, imessage);
      const allowedGroup = isGroup && this.config.photon.groupId && space.id === this.config.photon.groupId;
      const allowedDm = !isGroup && isAllowedDirectSender(sender, this.config.photon.dmAllowedSenders);
      if (!allowedGroup && !allowedDm) continue;
      this.logger.info("Ingesting inbound iMessage", { source_chat: space.id, sender, channel: allowedDm ? "dm" : "group" });
      await ingestInboundMessage(this.store, {
        sourceChat: space.id,
        sender,
        text: message.content.text,
        metadata: {
          channel: allowedDm ? "dm" : "group",
          photon_space_id: space.id,
          photon_sender: sender,
        },
      });
    }
  }

  async startLocalBridge() {
    const { IMessageSDK } = await import("@photon-ai/imessage-kit");
    const sdk = new IMessageSDK();
    const groups = await sdk.listChats({ kind: "group", sortBy: "recent", limit: 30 });
    for (const chat of groups) {
      if (chat.chatId) this.spaces.set(chat.chatId, { id: chat.chatId, type: "group" });
    }
    this.logger.info("Photon local bridge connected", {
      known_groups: groups.length,
      configured_group: this.config.photon.groupId || null,
      allowed_dm_senders: this.config.photon.dmAllowedSenders.length,
    });

    this.flushOutboundLoop(sdk).catch((error) => this.logger.error("Outbound loop failed", { error: error.message }));
    await sdk.startWatching({
      onGroupMessage: async (message) => this.handleLocalMessage(message),
      onDirectMessage: async (message) => this.handleLocalDirectMessage(message),
      onError: (error) => this.logger.error("Photon watcher error", { error: error.message }),
    });

    await new Promise(() => {});
  }

  async handleLocalMessage(message) {
    const sourceChat = message.chatId;
    if (sourceChat) this.spaces.set(sourceChat, { id: sourceChat, type: message.chatKind });
    if (!sourceChat || message.chatKind !== "group") return;
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (!message.text || message.kind !== "text") return;
    if (message.isFromMe) return;
    if (!this.config.photon.groupId || sourceChat !== this.config.photon.groupId) return;
    if (this.config.photon.selfIdentifier && message.participant === this.config.photon.selfIdentifier) return;

    this.logger.info("Ingesting inbound iMessage", {
      source_chat: sourceChat,
      sender: message.participant || "unknown",
      channel: "group",
    });
    await ingestInboundMessage(this.store, {
      sourceChat,
      sender: message.participant || "unknown",
      text: message.text,
      metadata: {
        channel: "group",
        photon_space_id: sourceChat,
        photon_sender: message.participant || "unknown",
      },
    });
  }

  async handleLocalDirectMessage(message) {
    const sender = message.participant || dmRecipientFromChatId(message.chatId) || "unknown";
    const sourceChat = dmChatIdForRecipient(message.chatId || sender);
    if (sourceChat) this.spaces.set(sourceChat, { id: sourceChat, type: "dm" });
    if (!sourceChat || message.chatKind !== "dm") return;
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (!message.text || message.kind !== "text") return;
    if (message.isFromMe) return;
    if (this.config.photon.selfIdentifier && isAllowedDirectSender(sender, [this.config.photon.selfIdentifier])) return;
    if (
      !isAllowedDirectSender(sender, this.config.photon.dmAllowedSenders) &&
      !isAllowedDirectSender(message.chatId, this.config.photon.dmAllowedSenders)
    ) {
      this.logger.debug("Ignoring direct iMessage from non-allowlisted sender", { id: message.id, sender });
      return;
    }

    this.logger.info("Ingesting inbound iMessage", {
      source_chat: sourceChat,
      sender,
      channel: "dm",
    });
    await ingestInboundMessage(this.store, {
      sourceChat,
      sender,
      text: message.text,
      metadata: {
        channel: "dm",
        photon_space_id: message.chatId || sourceChat,
        photon_sender: sender,
      },
    });
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
          const sendTarget = targetSpace?.id || this.resolveFallbackSendTarget(message);
          if (typeof app.send === "function" && sendTarget) {
            await app.send(sendTarget, { text: message.content, timeout: 30000 });
            await this.store.updateChatMessage(message.id, { delivery_status: OUTBOUND_STATUS.delivered, delivered_at: new Date().toISOString() });
            continue;
          }
          if (!targetSpace) {
            if (!this.config.photon.groupId || message.source_chat !== this.config.photon.groupId) {
              await this.store.updateChatMessage(message.id, {
                delivery_status: OUTBOUND_STATUS.skipped,
                metadata: { ...message.metadata, skipped_reason: "no configured Photon route for source_chat" },
              });
              continue;
            }
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

  resolveFallbackSendTarget(message) {
    const sourceChat = message.source_chat;
    if (!sourceChat || sourceChat === "group_chat") return null;
    if (this.config.photon.groupId && sourceChat === this.config.photon.groupId) return sourceChat;
    if (message.metadata?.channel === "dm") return dmChatIdForRecipient(sourceChat) || sourceChat;
    if (isAllowedDirectSender(sourceChat, this.config.photon.dmAllowedSenders)) return dmChatIdForRecipient(sourceChat) || sourceChat;
    return null;
  }
}
