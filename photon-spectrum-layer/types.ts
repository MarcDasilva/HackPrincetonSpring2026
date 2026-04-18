export interface IngestionPayload {
  thread_id: string;
  player_id: string;
  user_instruction: string;
}

export interface DedalusRequest {
  thread_id: string;
  user_instruction: string;
}

export interface DedalusResponse {
  status: "success" | "error";
  user_message: string;
}

export interface Session {
  thread_id: string;
  player_id: string;
  platform: string;
}
