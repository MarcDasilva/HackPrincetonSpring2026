import { queueOutboundMessage } from "../lib/photon-bridge.js";

export async function publishWorkerStatus(store, workerId, publicText, metadata = {}) {
  return queueOutboundMessage(store, {
    speakerAgentId: workerId,
    body: publicText,
    metadata,
  });
}
