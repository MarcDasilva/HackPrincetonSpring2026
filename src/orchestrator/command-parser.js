import { inferJobKindFromText, inferQuantityFromText, inferTargetFromText } from "../shared/job-types.js";
import { parseChatShortcut } from "../lib/photon-bridge.js";

export function parseHumanCommand(message) {
  const text = message.content || message.raw_text || "";
  const shortcut = parseChatShortcut(text);
  const kind = shortcut.kind || inferJobKindFromText(shortcut.text || text);
  const target = inferTargetFromText(shortcut.text || text, kind);
  const quantity = inferQuantityFromText(text);

  return {
    kind,
    target,
    quantity,
    source_message_id: message.id,
    preferred_worker_role: shortcut.preferred_worker_role || null,
    raw_text: text,
    shortcut: shortcut.shortcut || null,
  };
}

export function jobIdForCommand(intent) {
  const suffix = intent.source_message_id ? intent.source_message_id.slice(0, 8) : Date.now();
  return `cmd-${intent.kind}-${suffix}`;
}
