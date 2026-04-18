import express from "express";
import type { DedalusResponse } from "./types.js";

const app = express();
app.use(express.json());

app.post("/api/agent", (req, res) => {
  const { thread_id, user_instruction } = req.body;
  console.log(`[dedalus-mock] ${thread_id}: "${user_instruction}"`);

  const response: DedalusResponse = {
    status: "success",
    user_message: `Got it! I've dispatched the agent to ${user_instruction}. I'll text you when it's finished.`,
  };

  setTimeout(() => res.json(response), 500);
});

app.listen(5000, () => {
  console.log("Mock Dedalus agent listening on :5000");
});
