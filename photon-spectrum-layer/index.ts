import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import dotenv from "dotenv";
import { getOrCreateSession } from "./sessions.js";
import { sendToDedalus } from "./dedalus.js";
import type { IngestionPayload } from "./types.js";

dotenv.config();

async function main() {
  const app = await Spectrum({
    projectId: process.env.PHOTON_PROJECT_ID!,
    projectSecret: process.env.PHOTON_PROJECT_SECRET!,
    providers: [imessage.config()],
  });

  console.log("Photon Spectrum gateway connected. Awaiting messages...\n");

  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") continue;

    const instruction = message.content.text;
    const session = getOrCreateSession(message.sender.id, message.platform);

    const payload: IngestionPayload = {
      thread_id: session.thread_id,
      player_id: session.player_id,
      user_instruction: instruction,
    };

    console.log(`[ingestion] ${session.player_id} (${session.thread_id}): "${instruction}"`);

    await app.send(space, text("Got it! Dispatching your request to the agent..."));

    try {
      const response = await sendToDedalus({
        thread_id: payload.thread_id,
        user_instruction: payload.user_instruction,
      });

      await app.send(space, text(response.user_message));
      console.log(`[response] ${session.thread_id}: ${response.status}`);
    } catch (err: any) {
      console.error(`[error] Dedalus handoff failed for ${session.thread_id}:`, err.message);
      await app.send(space, text("Something went wrong processing your request. Try again shortly."));
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
