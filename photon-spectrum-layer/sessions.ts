import type { Session } from "./types.js";
import crypto from "crypto";

const sessions = new Map<string, Session>();

export function getOrCreateSession(senderId: string, platform: string): Session {
  const existing = sessions.get(senderId);
  if (existing) return existing;

  const session: Session = {
    thread_id: `thr_${crypto.randomBytes(4).toString("hex")}`,
    player_id: `player_${crypto.randomBytes(3).toString("hex")}`,
    platform,
  };

  sessions.set(senderId, session);
  return session;
}

export function getSession(senderId: string): Session | undefined {
  return sessions.get(senderId);
}
