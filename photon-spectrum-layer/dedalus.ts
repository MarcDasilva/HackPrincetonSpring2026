import axios from "axios";
import type { DedalusRequest, DedalusResponse } from "./types.js";

const DEDALUS_URL = process.env.DEDALUS_URL || "";

export async function sendToDedalus(request: DedalusRequest): Promise<DedalusResponse> {
  const { data } = await axios.post<DedalusResponse>(DEDALUS_URL, request, {
    timeout: 120_000,
  });
  return data;
}
