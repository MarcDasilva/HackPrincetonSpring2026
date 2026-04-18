import { queueOutboundMessage } from "../lib/photon-bridge.js";

export async function publishWorkerStatus(store, workerId, publicText, metadata = {}) {
  const { source_chat: sourceChat, sourceChat: camelSourceChat, ...restMetadata } = metadata;
  return queueOutboundMessage(store, {
    speakerAgentId: workerId,
    body: publicText,
    metadata: restMetadata,
    sourceChat: sourceChat || camelSourceChat || "group_chat",
  });
}
