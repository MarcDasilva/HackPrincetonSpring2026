import { inferJobKindFromText, inferQuantityFromText, inferTargetFromText } from "../shared/job-types.js";
import { parseChatShortcut } from "../lib/photon-bridge.js";
import { buildBaseSetupPlan, matchesBaseSetupRequest } from "./skills/base-setup.js";

function buildCoordinationPlan(text, quantity, message) {
  if (matchesBaseSetupRequest(text)) {
    return buildBaseSetupPlan({ text, quantity, sourceMessageId: message.id });
  }
  return null;
}

export function parseHumanCommand(message) {
  const text = message.content || message.raw_text || "";
  const shortcut = parseChatShortcut(text);
  const kind = shortcut.kind || inferJobKindFromText(shortcut.text || text);
  const target = inferTargetFromText(shortcut.text || text, kind);
  const quantity = inferQuantityFromText(text);
  const requestText = shortcut.text || text;

  return {
    kind,
    target,
    quantity,
    source_message_id: message.id,
    source_chat: message.source_chat,
    sender: message.sender || null,
    preferred_worker_id: shortcut.preferred_worker_id || null,
    preferred_worker_role: shortcut.preferred_worker_role || null,
    target_worker_ids: shortcut.target_worker_ids || [],
    raw_text: text,
    request_text: requestText,
    shortcut: shortcut.shortcut || null,
    plan: buildCoordinationPlan(requestText, quantity, message),
  };
}

export function jobIdForCommand(intent, index = 0) {
  const suffix = intent.source_message_id ? intent.source_message_id.slice(0, 8) : Date.now();
  const part = index ? `-${index + 1}` : "";
  return `cmd-${intent.kind}-${suffix}${part}`;
}
