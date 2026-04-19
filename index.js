/**
 * Photon iMessage local orchestrator.
 *
 * Flow:
 * 1. Photon receives a user request.
 * 2. OpenAI proposes a local bot orchestration plan and asks for approval.
 * 3. If approved, a central orchestrator starts local Voyager bot workers.
 * 4. Worker progress is tracked locally and mirrored to Supabase shared memory.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
try { require("dotenv").config(); } catch (e) { /* dotenv optional */ }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import net from "net";
import http from "http";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isExecutableFile(candidatePath) {
  try {
    return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile();
  } catch (error) {
    return false;
  }
}

function isExistingDirectory(candidatePath) {
  try {
    return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory();
  } catch (error) {
    return false;
  }
}

function isVoyagerRepoRoot(candidatePath) {
  if (!isExistingDirectory(candidatePath)) return false;
  return fs.existsSync(path.join(candidatePath, "voyager", "__init__.py"));
}

function resolvePythonBin() {
  const preferred = process.env.PYTHON_BIN;
  if (preferred) return preferred;

  const candidates = [
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];

  for (const candidate of candidates) {
    if (!candidate.includes("/")) return candidate;
    if (isExecutableFile(candidate)) return candidate;
  }

  return "python3";
}

function resolveVoyagerPath() {
  const configured = process.env.VOYAGER_PATH;
  const fallback = __dirname;

  if (configured && isVoyagerRepoRoot(configured)) {
    return configured;
  }

  if (configured && !isVoyagerRepoRoot(configured) && isVoyagerRepoRoot(fallback)) {
    console.warn(
      `⚠️ VOYAGER_PATH is not a Voyager repo root (${configured}). Falling back to ${fallback}.`
    );
    return fallback;
  }

  return configured || fallback;
}

function getPhotonCredentials() {
  const projectId = process.env.PHOTON_PROJECT_ID || process.env.PROJECT_ID;
  const projectSecret =
    process.env.PHOTON_PROJECT_SECRET ||
    process.env.PROJECT_SECRET ||
    process.env.SECRET_KEY;

  return {
    projectId,
    projectSecret,
    enabled: Boolean(projectId && projectSecret),
  };
}

function parseSupabaseProjectRef(urlValue) {
  if (!urlValue) return "";
  try {
    const host = new URL(urlValue).hostname;
    const match = host.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return match?.[1] || "";
  } catch (error) {
    return "";
  }
}

function resolveSharedMemoryProjectId() {
  return (
    process.env.SUPABASE_PROJECT_ID ||
    process.env.SUPABASE_PROJECT_REF ||
    process.env.PHOTON_PROJECT_ID ||
    process.env.PROJECT_ID ||
    parseSupabaseProjectRef(process.env.SUPABASE_URL || "") ||
    ""
  );
}

function resolveSharedMemoryContextTag() {
  return (
    process.env.SUPABASE_CT ||
    process.env.PHOTON_CT ||
    process.env.CT ||
    process.env.PHOTON_SPACE_ID ||
    ""
  );
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const VOYAGER_PATH = "/Users/marc/Voyager-1";
const MC_HOST = process.env.VOYAGER_MC_HOST || "127.0.0.1";
const MC_PORT = parseInt(process.env.VOYAGER_MC_PORT || "25565", 10);
const BASE_SERVER_PORT = parseInt(process.env.VOYAGER_SERVER_PORT || "3000", 10);
const BOT_NAME_PREFIX = process.env.VOYAGER_BOT_PREFIX || "vgr";
const PYTHON_BIN = resolvePythonBin();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_SHARED_MEMORY_TABLE =
  process.env.SUPABASE_SHARED_MEMORY_TABLE || "agent_memory";
const SUPABASE_PROJECT_ID = resolveSharedMemoryProjectId();
const SUPABASE_CONTEXT_TAG = resolveSharedMemoryContextTag();
const SUPABASE_MEMORY_SEARCH_RPC = process.env.SUPABASE_MEMORY_SEARCH_RPC || "";
const SUPABASE_MEMORY_SEARCH_LIMIT = Math.max(
  1,
  parseInt(process.env.SUPABASE_MEMORY_SEARCH_LIMIT || "6", 10)
);
const SUPABASE_MEMORY_RECENT_FETCH_LIMIT = Math.max(
  SUPABASE_MEMORY_SEARCH_LIMIT,
  parseInt(process.env.SUPABASE_MEMORY_RECENT_FETCH_LIMIT || "160", 10)
);
const VOYAGER_MEMORY_MCP_ENABLED =
  `${process.env.VOYAGER_MEMORY_MCP_ENABLED || "1"}` !== "0";

const PHOTON_TRACKING_DIR =
  process.env.PHOTON_TRACKING_DIR || path.join(__dirname, "photon-progress");
const PROPOSALS_DIR = path.join(PHOTON_TRACKING_DIR, "proposals");
const RUNS_DIR = path.join(PHOTON_TRACKING_DIR, "runs");
const TRACKER_INDEX_PATH = path.join(PHOTON_TRACKING_DIR, "index.json");
const PROCESS_LOCK_PATH = path.join(PHOTON_TRACKING_DIR, "photon.lock");
const DASHBOARD_PORT = parseInt(process.env.VOYAGER_DASHBOARD_PORT || "8787", 10);
const DASHBOARD_HOST = process.env.VOYAGER_DASHBOARD_HOST || "127.0.0.1";
const DASHBOARD_EVENT_LIMIT = Math.max(
  100,
  parseInt(process.env.VOYAGER_DASHBOARD_EVENT_LIMIT || "1500", 10)
);
const AGENT_TRANSIENT_RESTARTS = Math.max(
  0,
  parseInt(process.env.VOYAGER_AGENT_TRANSIENT_RESTARTS || "3", 10)
);
const AGENT_TRANSIENT_RESTART_DELAY_MS = Math.max(
  250,
  parseInt(process.env.VOYAGER_AGENT_TRANSIENT_RESTART_DELAY_MS || "2000", 10)
);
const AGENT_START_STAGGER_MS = Math.max(
  0,
  parseInt(process.env.VOYAGER_AGENT_START_STAGGER_MS || "0", 10)
);
const VOYAGER_DECOMPOSE_TIMEOUT_SEC = Math.max(
  10,
  parseInt(process.env.VOYAGER_DECOMPOSE_TIMEOUT_SEC || "75", 10)
);
const VOYAGER_ENV_REQUEST_TIMEOUT = Math.max(
  30,
  parseInt(process.env.VOYAGER_ENV_REQUEST_TIMEOUT || "180", 10)
);
const VOYAGER_SKIP_DECOMPOSE_FOR_MULTI_AGENT =
  `${process.env.VOYAGER_SKIP_DECOMPOSE_FOR_MULTI_AGENT || "1"}` !== "0";
const VOYAGER_RESET_ENV_BETWEEN_SUBGOALS =
  `${process.env.VOYAGER_RESET_ENV_BETWEEN_SUBGOALS || "0"}` !== "0";

const pendingApprovals = new Map();
const activeRuns = new Map();
const allRuns = new Map();
const spaceRuns = new Map();
const recentMessageSignatures = new Map();
const recentBotOutboundSignatures = new Map();
let dashboardServer = null;
const MAX_IMPLICIT_AGENT_COUNT = 1;
const MAX_EXPLICIT_AGENT_COUNT = 6;

const CANONICAL_WORKER_ROLES = ["miner", "builder", "forager"];

const MINECRAFT_AGENT_BOILERPLATE = [
  "Share the task and how many agents you want.",
  "I'll reply with Task + Agents and ask if it's good before launch.",
].join("\n");

const LOCATION_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "your",
  "this",
  "that",
  "those",
  "these",
  "it",
  "them",
  "here",
  "there",
  "minecraft",
  "server",
  "world",
  "chest",
  "item",
  "items",
  "resource",
  "resources",
]);

function toTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeParseJsonObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function parseCoordinateNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseCoordinateTripletFromText(text) {
  const normalized = toTrimmedString(text);
  if (!normalized) return null;

  const xyzMatch = normalized.match(
    /x\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[, ]+\s*y\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[, ]+\s*z\s*[:=]\s*(-?\d+(?:\.\d+)?)/i
  );
  if (xyzMatch) {
    return {
      x: Number(xyzMatch[1]),
      y: Number(xyzMatch[2]),
      z: Number(xyzMatch[3]),
    };
  }

  const unlabeledMatch = normalized.match(
    /\b(-?\d+(?:\.\d+)?)\s*[, ]+\s*(-?\d+(?:\.\d+)?)\s*[, ]+\s*(-?\d+(?:\.\d+)?)\b/
  );
  if (unlabeledMatch) {
    return {
      x: Number(unlabeledMatch[1]),
      y: Number(unlabeledMatch[2]),
      z: Number(unlabeledMatch[3]),
    };
  }

  return null;
}

function parseCoordinatesFromValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  if (
    typeof value.coordinates === "object" &&
    value.coordinates &&
    !Array.isArray(value.coordinates)
  ) {
    const nested = parseCoordinatesFromValue(value.coordinates);
    if (nested) return nested;
  }

  const x = parseCoordinateNumber(value.x ?? value.pos_x ?? value.coord_x);
  const y = parseCoordinateNumber(value.y ?? value.pos_y ?? value.coord_y);
  const z = parseCoordinateNumber(value.z ?? value.pos_z ?? value.coord_z);
  if (x !== null && y !== null && z !== null) {
    return { x, y, z };
  }

  return null;
}

function parseCoordinatesFromRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const direct = parseCoordinatesFromValue(record);
  if (direct) return direct;

  const payload = safeParseJsonObject(record.payload) || {};
  const metadata = safeParseJsonObject(record.metadata) || {};
  const meta = safeParseJsonObject(record.meta) || {};

  for (const candidate of [payload, metadata, meta]) {
    const fromObj = parseCoordinatesFromValue(candidate);
    if (fromObj) return fromObj;
  }

  const textSource = [
    record.content,
    record.message,
    record.raw_text,
    payload.content,
    payload.message,
    metadata.content,
    metadata.message,
  ]
    .map((value) => toTrimmedString(value))
    .find(Boolean);

  return textSource ? parseCoordinateTripletFromText(textSource) : null;
}

function formatCoordinates(coordinates) {
  if (!coordinates) return "";
  const x = Number(coordinates.x);
  const y = Number(coordinates.y);
  const z = Number(coordinates.z);
  if (![x, y, z].every((value) => Number.isFinite(value))) return "";
  return `x=${x}, y=${y}, z=${z}`;
}

function normalizeAlias(value) {
  return toTrimmedString(value)
    .toLowerCase()
    .replace(/[^a-z0-9 _-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLocationMentions(text) {
  const normalized = toTrimmedString(text).toLowerCase();
  if (!normalized) return [];

  const mentions = new Set();
  const mentionPatterns = [
    /\b(?:from|to|at|near|inside|within|around|towards)\s+([a-z][a-z0-9_-]*(?:\s+[a-z0-9_-]+){0,2})\b/g,
    /\b(?:named|called)\s+([a-z][a-z0-9_-]*(?:\s+[a-z0-9_-]+){0,2})\b/g,
    /["'`](.+?)["'`]/g,
  ];

  for (const pattern of mentionPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      const mention = normalizeAlias(match[1]);
      if (!mention) continue;
      if (mention.length < 2) continue;
      if (LOCATION_STOP_WORDS.has(mention)) continue;
      mentions.add(mention);
    }
  }

  if (/\bhome\b/.test(normalized)) mentions.add("home");
  if (/\bbase\b/.test(normalized)) mentions.add("base");
  if (/\bhq\b/.test(normalized)) mentions.add("hq");

  return [...mentions];
}

function extractLocationAliasesFromText(text) {
  const normalized = toTrimmedString(text).toLowerCase();
  if (!normalized) return [];
  const aliases = new Set(extractLocationMentions(normalized));

  const aliasPattern =
    /\b([a-z][a-z0-9_-]*(?:\s+[a-z0-9_-]+){0,2})\s+(?:is|=|:)?\s*(?:at|coords?|coordinates?)\b/g;
  for (const match of normalized.matchAll(aliasPattern)) {
    const alias = normalizeAlias(match[1]);
    if (!alias) continue;
    if (LOCATION_STOP_WORDS.has(alias)) continue;
    aliases.add(alias);
  }

  return [...aliases];
}

function parseEmbeddingVector(value) {
  if (Array.isArray(value)) {
    const parsed = value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
    return parsed.length > 0 ? parsed : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        return parseEmbeddingVector(parsed);
      } catch (error) {
        return null;
      }
    }
  }

  return null;
}

function cosineSimilarity(vectorA, vectorB) {
  if (!Array.isArray(vectorA) || !Array.isArray(vectorB)) return null;
  if (vectorA.length === 0 || vectorB.length === 0) return null;
  if (vectorA.length !== vectorB.length) return null;

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < vectorA.length; i += 1) {
    const a = Number(vectorA[i]);
    const b = Number(vectorB[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    dot += a * b;
    magnitudeA += a * a;
    magnitudeB += b * b;
  }
  if (magnitudeA <= 0 || magnitudeB <= 0) return null;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function tokenizeForSimilarity(text) {
  return new Set(
    toTrimmedString(text)
      .toLowerCase()
      .split(/[^a-z0-9_-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !LOCATION_STOP_WORDS.has(token))
  );
}

function keywordOverlapScore(queryText, candidateText) {
  const queryTokens = tokenizeForSimilarity(queryText);
  const candidateTokens = tokenizeForSimilarity(candidateText);
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function summarizeMemoryText(text, maxLength = 180) {
  const normalized = toTrimmedString(text).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function latestConversationText(conversation) {
  const entries = ensureArray(conversation);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry === "string" && entry.trim()) return entry.trim();
    if (typeof entry?.text === "string" && entry.text.trim()) return entry.text.trim();
  }
  return "";
}

function parseSlashMemoryCommand(text) {
  const trimmed = toTrimmedString(text);
  if (!/^\/memory\b/i.test(trimmed)) return null;

  const body = trimmed.replace(/^\/memory\b[:\s-]*/i, "").trim();
  if (!body) {
    return { action: "help" };
  }

  const [subcommandRaw, ...rest] = body.split(/\s+/);
  const subcommand = toTrimmedString(subcommandRaw).toLowerCase();
  const remainder = rest.join(" ").trim();

  if (["log", "add", "remember", "save", "store"].includes(subcommand)) {
    return { action: "log", text: remainder };
  }
  if (["find", "search", "query", "lookup"].includes(subcommand)) {
    return { action: "search", query: remainder };
  }
  if (["recent", "list", "latest"].includes(subcommand)) {
    return { action: "recent" };
  }
  if (["help"].includes(subcommand)) {
    return { action: "help" };
  }

  return { action: "log", text: body };
}

function parseNaturalMemoryLogCommand(text) {
  const trimmed = toTrimmedString(text);
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (!/\b(supabase|database|db)\b/.test(lower)) return null;
  if (!/^(please\s+)?(log|remember|save|store)\b/.test(lower)) return null;

  const withoutPrefix = trimmed.replace(/^(please\s+)?(log|remember|save|store)\b[:\s-]*/i, "");
  const withoutDestination = withoutPrefix.replace(
    /\b(?:in|into|to)\s+(?:the\s+)?(?:supabase|database|db)\b.*$/i,
    ""
  );
  const memoryText = toTrimmedString(withoutDestination) || toTrimmedString(withoutPrefix);

  return memoryText ? { action: "log", text: memoryText } : null;
}

const HELP_TEXT = [
  "Photon local orchestration commands:",
  "/status — show pending draft and active runs for this chat",
  "/status RUN_ID — show details for one run",
  "/approve — launch the current draft",
  "/override ROLE|ASSIGNMENT_ID [TASK] — force agent by role or assignment id",
  "/cancel — clear the current draft, or cancel an active run with a run id",
  "/end — stop this chat session (cancels pending/active work)",
  "/new TASK — cancel active run and start a replacement task",
  "/memory log <TEXT> — write explicit long-term memory to Supabase",
  "/memory find <QUERY> — search Supabase memory (semantic + coordinate recall)",
  "/memory recent — show recent memory entries for this chat",
  "/help — show this help",
  "",
  "Normal flow:",
  "1. Send a task.",
  "2. Photon proposes a local multi-bot plan.",
  "3. Reply YES to launch, or reply with edits to revise the plan.",
].join("\n");

class SupabaseSharedMemoryStore {
  constructor() {
    this.url = SUPABASE_URL;
    this.key = SUPABASE_SERVICE_ROLE_KEY;
    this.table = SUPABASE_SHARED_MEMORY_TABLE;
    this.projectId = SUPABASE_PROJECT_ID;
    this.contextTag = SUPABASE_CONTEXT_TAG;
    this.enabled = VOYAGER_MEMORY_MCP_ENABLED && Boolean(this.url && this.key);
    this.disabledByFlag = !VOYAGER_MEMORY_MCP_ENABLED;
    this.unsupportedColumnsByTable = new Map();
    this.knownAgentIds = new Set();
    this.embeddingCache = new Map();
    this.unavailableRpcFunctions = new Set();
    this.rpcSearchCandidates = uniqueStrings(
      [
        SUPABASE_MEMORY_SEARCH_RPC,
        "match_agent_memory",
        "match_agent_memories",
        "match_memories",
        "match_documents",
      ].filter(Boolean)
    );
  }

  _buildHeaders(prefer = "return=minimal") {
    const headers = {
      "Content-Type": "application/json",
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      Prefer: prefer,
    };

    if (this.projectId) {
      headers["x-project-id"] = this.projectId;
      headers["x-project-ref"] = this.projectId;
    }

    if (this.contextTag) {
      headers["x-ct"] = this.contextTag;
      headers["x-context-id"] = this.contextTag;
    }

    return headers;
  }

  _buildEndpoint(tableName) {
    return `${this.url.replace(/\/$/, "")}/rest/v1/${tableName}`;
  }

  _buildRpcEndpoint(functionName) {
    return `${this.url.replace(/\/$/, "")}/rest/v1/rpc/${functionName}`;
  }

  _rememberEmbedding(cacheKey, vector) {
    if (!cacheKey || !Array.isArray(vector) || vector.length === 0) return;
    this.embeddingCache.set(cacheKey, vector);
    if (this.embeddingCache.size <= 200) return;
    const oldest = this.embeddingCache.keys().next().value;
    if (oldest) {
      this.embeddingCache.delete(oldest);
    }
  }

  async _insert(tableName, entry) {
    const endpoint = this._buildEndpoint(tableName);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: this._buildHeaders("return=minimal"),
      body: JSON.stringify(entry),
    });

    return response;
  }

  async _upsertAgentStatus(agentId, createdAt = null) {
    if (!agentId) return;
    if (this.knownAgentIds.has(agentId)) return;

    const endpoint = this._buildEndpoint("agent_status");
    const payload = {
      agent_id: agentId,
      display_name: agentId,
      status: "idle",
      last_heartbeat: createdAt || nowIso(),
      role: agentId === "foreman" ? "foreman" : "worker",
      metadata: { source: "photon_local_orchestrator" },
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: this._buildHeaders("return=minimal,resolution=merge-duplicates"),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase agent_status upsert failed (${response.status}): ${text}`);
    }

    this.knownAgentIds.add(agentId);
  }

  _extractMissingColumn(errorPayload) {
    const message = `${errorPayload?.message || ""}`;
    const match = message.match(/Could not find the '([^']+)' column/i);
    return match?.[1] || null;
  }

  _extractNotNullColumn(errorPayload) {
    const message = `${errorPayload?.message || ""}`;
    const match = message.match(/null value in column "([^"]+)"/i);
    return match?.[1] || null;
  }

  _extractCheckConstraint(errorPayload) {
    const message = `${errorPayload?.message || ""}`;
    const match = message.match(/violates check constraint "([^"]+)"/i);
    return match?.[1] || null;
  }

  _extractMissingForeignKeyAgent(errorPayload) {
    const details = `${errorPayload?.details || ""}`;
    const match = details.match(/Key \(agent_id\)=\(([^)]+)\) is not present/i);
    return match?.[1] || null;
  }

  _canonicalMemoryType(value) {
    const normalized = `${value || ""}`.trim().toLowerCase();
    // Keep this intentionally conservative for broad schema compatibility.
    return normalized === "observation" ? "observation" : "observation";
  }

  _withoutKey(entry, key) {
    if (!key || !(key in entry)) return entry;
    const copy = { ...entry };
    delete copy[key];
    return copy;
  }

  _withDefaultForRequiredColumn(entry, column) {
    if (!column) return entry;
    if (entry[column] !== undefined && entry[column] !== null) {
      return entry;
    }

    const withValue = (value) => ({ ...entry, [column]: value });
    const messageText =
      entry.message ||
      entry.content ||
      `${entry.event_type || entry.memory_type || "log"} event`;

    switch (column) {
      case "agent_id":
        return withValue(entry.agent_id || entry.role || "foreman");
      case "content":
      case "message":
      case "raw_text":
        return withValue(messageText);
      case "event_type":
      case "memory_type":
      case "type":
        return withValue(this._canonicalMemoryType(entry.memory_type || entry.event_type));
      case "payload":
      case "metadata":
      case "meta":
        return withValue(entry.payload ?? {});
      case "created_at":
      case "updated_at":
      case "timestamp":
        return withValue(entry.created_at || nowIso());
      case "project":
      case "project_id":
      case "project_ref":
        return this.projectId ? withValue(this.projectId) : entry;
      case "ct":
      case "context":
      case "context_id": {
        const contextValue = entry.ct || entry.space_id || this.contextTag || this.projectId;
        return contextValue ? withValue(contextValue) : entry;
      }
      default:
        return withValue("");
    }
  }

  _withContextDefaults(entry) {
    const next = { ...entry };

    if (this.projectId) {
      if (!next.project_id) next.project_id = this.projectId;
      if (!next.project) next.project = this.projectId;
      if (!next.project_ref) next.project_ref = this.projectId;
    }

    const contextValue = next.ct || next.space_id || this.contextTag;
    if (contextValue && !next.ct) {
      next.ct = contextValue;
    }

    return next;
  }

  _unsupportedColumnsFor(tableName) {
    if (!this.unsupportedColumnsByTable.has(tableName)) {
      this.unsupportedColumnsByTable.set(tableName, new Set());
    }
    return this.unsupportedColumnsByTable.get(tableName);
  }

  _rememberUnsupportedColumn(tableName, column) {
    if (!tableName || !column) return;
    this._unsupportedColumnsFor(tableName).add(column);
  }

  _dropUnsupportedColumns(tableName, entry) {
    const unsupported = this._unsupportedColumnsFor(tableName);
    if (!unsupported.size) return entry;

    const copy = { ...entry };
    for (const column of unsupported) {
      delete copy[column];
    }
    return copy;
  }

  async _readErrorPayload(response) {
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      text = "";
    }

    if (!text) {
      return {
        payload: null,
        text: "",
      };
    }

    try {
      return {
        payload: JSON.parse(text),
        text,
      };
    } catch (error) {
      return {
        payload: null,
        text,
      };
    }
  }

  async append(entry) {
    if (!this.enabled) return;

    let tableName = this.table;
    let payload = this._dropUnsupportedColumns(tableName, this._withContextDefaults({ ...entry }));
    if (payload.agent_id) {
      await this._upsertAgentStatus(payload.agent_id, payload.created_at);
    }
    let lastStatus = 0;
    let lastErrorText = "";

    for (let attempts = 0; attempts < 24; attempts += 1) {
      const response = await this._insert(tableName, payload);
      if (response.ok) {
        if (tableName !== this.table) {
          this.table = tableName;
        }
        return;
      }

      lastStatus = response.status;
      const { payload: errorPayload, text } = await this._readErrorPayload(response);
      lastErrorText = text;

      // If configured/default table does not exist, use Supabase's hint.
      if (response.status === 404 && errorPayload?.code === "PGRST205") {
        const hinted = `${errorPayload?.hint || ""}`.match(/table '([^']+)'/i);
        const hintedTable = hinted?.[1]?.split(".")?.pop();
        if (hintedTable && hintedTable !== tableName) {
          tableName = hintedTable;
          payload = this._dropUnsupportedColumns(
            tableName,
            this._withContextDefaults({ ...entry })
          );
          continue;
        }
      }

      // If table exists but schema differs, remove unknown columns and retry.
      if (response.status === 400 && errorPayload?.code === "PGRST204") {
        const missingColumn = this._extractMissingColumn(errorPayload);
        if (missingColumn && missingColumn in payload) {
          this._rememberUnsupportedColumn(tableName, missingColumn);
          payload = this._withoutKey(payload, missingColumn);
          if (Object.keys(payload).length > 0) {
            continue;
          }
          lastErrorText = `All payload keys were removed while adapting to ${tableName} schema.`;
        }
      }

      // If a required column is NULL, synthesize a safe fallback and retry.
      if (response.status === 400 && errorPayload?.code === "23502") {
        const requiredColumn = this._extractNotNullColumn(errorPayload);
        if (requiredColumn) {
          const nextPayload = this._withDefaultForRequiredColumn(payload, requiredColumn);
          if (
            JSON.stringify(nextPayload) !== JSON.stringify(payload) &&
            Object.keys(nextPayload).length > 0
          ) {
            payload = nextPayload;
            continue;
          }
        }
      }

      // If a CHECK constraint fails, coerce known constrained columns and retry.
      if (response.status === 400 && errorPayload?.code === "23514") {
        const constraint = this._extractCheckConstraint(errorPayload);
        if (constraint && /memory_type/i.test(constraint)) {
          const nextPayload = {
            ...payload,
            memory_type: this._canonicalMemoryType(payload.memory_type),
          };
          if (JSON.stringify(nextPayload) !== JSON.stringify(payload)) {
            payload = nextPayload;
            continue;
          }
        }
      }

      // Some gateways require explicit project/context fields or headers.
      if (response.status === 400) {
        const lowerMessage = `${errorPayload?.message || text || ""}`.toLowerCase();
        if (
          this.projectId &&
          /project not specified/.test(lowerMessage) &&
          (!payload.project_id || !payload.project || !payload.project_ref)
        ) {
          payload = this._dropUnsupportedColumns(tableName, this._withContextDefaults(payload));
          continue;
        }

        if (/\bct\b[^.\n\r]*not specified/.test(lowerMessage)) {
          const contextValue = payload.ct || payload.space_id || this.contextTag || this.projectId;
          if (contextValue && payload.ct !== contextValue) {
            payload = this._dropUnsupportedColumns(tableName, { ...payload, ct: contextValue });
            continue;
          }
        }
      }

      // If agent_id foreign key fails, create the missing agent and retry.
      if ((response.status === 409 || response.status === 400) && errorPayload?.code === "23503") {
        const missingAgentId = this._extractMissingForeignKeyAgent(errorPayload);
        if (missingAgentId) {
          await this._upsertAgentStatus(missingAgentId, payload.created_at);
          payload = {
            ...payload,
            agent_id: payload.agent_id || missingAgentId,
          };
          continue;
        }
      }

      break;
    }

    throw new Error(`Supabase insert failed (${lastStatus}): ${lastErrorText}`);
  }

  _normalizeMemoryRow(row, source = "table") {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;

    const payload = safeParseJsonObject(row.payload) || {};
    const metadata = safeParseJsonObject(row.metadata) || {};
    const meta = safeParseJsonObject(row.meta) || {};

    const text = [
      row.content,
      row.message,
      row.raw_text,
      row.text,
      payload.content,
      payload.message,
      payload.text,
      metadata.content,
      metadata.message,
      meta.content,
      meta.message,
    ]
      .map((value) => toTrimmedString(value))
      .find(Boolean);

    if (!text) return null;

    const aliases = uniqueStrings(
      [
        row.location_name,
        row.location,
        row.label,
        row.memory_key,
        payload.location_name,
        payload.location,
        payload.label,
        payload.memory_key,
        ...(Array.isArray(payload.aliases) ? payload.aliases : []),
        ...(Array.isArray(metadata.aliases) ? metadata.aliases : []),
        ...(Array.isArray(meta.aliases) ? meta.aliases : []),
        ...extractLocationAliasesFromText(text),
      ]
        .map((value) => normalizeAlias(value))
        .filter(Boolean)
    );

    const similarity = Number(row.similarity ?? row.score);
    const distance = Number(row.distance);
    const vectorScore = Number.isFinite(similarity)
      ? similarity
      : Number.isFinite(distance)
        ? 1 - distance
        : null;

    return {
      id:
        toTrimmedString(row.id) ||
        toTrimmedString(row.memory_id) ||
        toTrimmedString(row.uuid) ||
        `${toTrimmedString(row.created_at)}:${text.slice(0, 48)}`,
      text,
      message: toTrimmedString(row.message) || toTrimmedString(row.content) || text,
      created_at:
        toTrimmedString(row.created_at) ||
        toTrimmedString(row.timestamp) ||
        toTrimmedString(row.updated_at) ||
        "",
      agent_id:
        toTrimmedString(row.agent_id) ||
        toTrimmedString(payload.agent_id) ||
        toTrimmedString(metadata.agent_id) ||
        "",
      sender_id:
        toTrimmedString(row.sender_id) ||
        toTrimmedString(payload.sender_id) ||
        toTrimmedString(metadata.sender_id) ||
        "",
      space_id:
        toTrimmedString(row.space_id) ||
        toTrimmedString(row.ct) ||
        toTrimmedString(payload.space_id) ||
        toTrimmedString(payload.ct) ||
        toTrimmedString(metadata.space_id) ||
        "",
      event_type:
        toTrimmedString(row.event_type) ||
        toTrimmedString(row.memory_type) ||
        toTrimmedString(payload.event_type) ||
        "observation",
      coordinates: parseCoordinatesFromRecord({ ...row, payload, metadata, meta }),
      aliases,
      embedding: parseEmbeddingVector(
        row.embedding ??
          row.vector ??
          payload.embedding ??
          payload.vector ??
          metadata.embedding ??
          meta.embedding
      ),
      vector_score: Number.isFinite(vectorScore) ? vectorScore : null,
      source,
      raw: row,
    };
  }

  _matchesContext(memory, { spaceId = "", senderId = "" } = {}) {
    if (!memory) return false;
    const normalizedSpace = toTrimmedString(spaceId);
    const normalizedSender = toTrimmedString(senderId);
    const memorySpace = toTrimmedString(memory.space_id);
    const memorySender = toTrimmedString(memory.sender_id);

    if (normalizedSpace && memorySpace && memorySpace !== normalizedSpace) {
      return false;
    }
    if (
      normalizedSender &&
      memorySender &&
      memorySender !== normalizedSender &&
      !memorySpace
    ) {
      return false;
    }
    return true;
  }

  _scoreMemory(memory, { query, queryEmbedding = null, locationMentions = [] } = {}) {
    if (!memory) return 0;

    let score = keywordOverlapScore(query, memory.text);
    if (queryEmbedding && memory.embedding) {
      const semantic = cosineSimilarity(queryEmbedding, memory.embedding);
      if (typeof semantic === "number" && Number.isFinite(semantic)) {
        score += Math.max(0, semantic) * 1.15;
      }
    }
    if (typeof memory.vector_score === "number" && Number.isFinite(memory.vector_score)) {
      score += Math.max(0, memory.vector_score) * 1.25;
    }

    for (const mention of locationMentions) {
      if (!mention) continue;
      if (memory.aliases.some((alias) => alias === mention || alias.includes(mention))) {
        score += 0.75;
      } else if (memory.text.toLowerCase().includes(mention)) {
        score += 0.35;
      }
    }

    if (memory.coordinates) {
      score += 0.2;
    }

    if (memory.created_at) {
      const timestamp = Date.parse(memory.created_at);
      if (!Number.isNaN(timestamp)) {
        const ageHours = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60));
        score += Math.max(0, 0.3 - ageHours / (24 * 10));
      }
    }

    return score;
  }

  async _fetchRecentRows({ limit = SUPABASE_MEMORY_RECENT_FETCH_LIMIT, tableName = this.table } = {}) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.floor(limit));
    const endpoint = this._buildEndpoint(tableName);

    const candidateUrls = [
      `${endpoint}?select=*&order=created_at.desc.nullslast&limit=${safeLimit}`,
      `${endpoint}?select=*&order=id.desc&limit=${safeLimit}`,
      `${endpoint}?select=*&limit=${safeLimit}`,
    ];

    let lastErrorText = "";
    for (const url of candidateUrls) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: this._buildHeaders(),
        });

        if (response.ok) {
          const data = await response.json().catch(() => []);
          return Array.isArray(data) ? data : [];
        }

        const { payload: errorPayload, text } = await this._readErrorPayload(response);
        lastErrorText = text || lastErrorText;
        if (response.status === 404 && errorPayload?.code === "PGRST205") {
          const hinted = `${errorPayload?.hint || ""}`.match(/table '([^']+)'/i);
          const hintedTable = hinted?.[1]?.split(".")?.pop();
          if (hintedTable && hintedTable !== tableName) {
            this.table = hintedTable;
            return this._fetchRecentRows({ limit: safeLimit, tableName: hintedTable });
          }
        }
      } catch (error) {
        lastErrorText = error.message || lastErrorText;
      }
    }

    if (lastErrorText) {
      console.warn(`⚠️ Supabase memory read fallback failed: ${lastErrorText}`);
    }
    return [];
  }

  async _createEmbedding(text) {
    const normalized = toTrimmedString(text);
    if (!normalized || !OPENAI_API_KEY) return null;

    const cacheKey = normalized.toLowerCase();
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey);
    }

    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: OPENAI_EMBEDDING_MODEL,
          input: normalized,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(
          `⚠️ Embedding request failed (${response.status}). Continuing without vector lookup. ${errorText}`
        );
        return null;
      }

      const data = await response.json().catch(() => ({}));
      const embedding = parseEmbeddingVector(data?.data?.[0]?.embedding);
      if (embedding) {
        this._rememberEmbedding(cacheKey, embedding);
      }
      return embedding;
    } catch (error) {
      console.warn(
        `⚠️ Embedding lookup threw an error. Continuing without vector lookup. ${error.message}`
      );
      return null;
    }
  }

  _rpcPayloadCandidates({ query, queryEmbedding, limit, spaceId, senderId }) {
    const filter = {};
    if (spaceId) filter.space_id = spaceId;
    if (senderId) filter.sender_id = senderId;

    const baseCandidates = [
      {
        query_embedding: queryEmbedding,
        match_count: limit,
        match_threshold: 0,
        filter,
      },
      {
        embedding: queryEmbedding,
        match_count: limit,
        match_threshold: 0,
        filter,
      },
      {
        query_embedding: queryEmbedding,
        limit,
        query,
        space_id: spaceId || undefined,
        sender_id: senderId || undefined,
      },
      {
        embedding: queryEmbedding,
        limit,
        query,
        space_id: spaceId || undefined,
        sender_id: senderId || undefined,
      },
    ];

    return baseCandidates.map((candidate) => {
      const compact = {};
      for (const [key, value] of Object.entries(candidate)) {
        if (value === undefined) continue;
        if (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) {
          continue;
        }
        compact[key] = value;
      }
      return compact;
    });
  }

  async _searchViaRpc({ query, queryEmbedding, limit, spaceId, senderId }) {
    if (!this.enabled) return [];
    if (!queryEmbedding) return [];
    if (!this.rpcSearchCandidates.length) return [];

    const safeLimit = Math.max(1, Math.floor(limit));
    const payloadCandidates = this._rpcPayloadCandidates({
      query,
      queryEmbedding,
      limit: safeLimit,
      spaceId,
      senderId,
    });

    for (const functionName of this.rpcSearchCandidates) {
      if (this.unavailableRpcFunctions.has(functionName)) continue;
      const endpoint = this._buildRpcEndpoint(functionName);

      let markUnavailable = false;
      for (const payload of payloadCandidates) {
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: this._buildHeaders(),
            body: JSON.stringify(payload),
          });

          if (response.ok) {
            const data = await response.json().catch(() => []);
            if (!Array.isArray(data)) return [];

            const normalized = data
              .map((row) => {
                if (!row || typeof row !== "object") return null;
                const candidate = row.memory && typeof row.memory === "object" ? row.memory : row;
                const normalizedRow = this._normalizeMemoryRow(candidate, `rpc:${functionName}`);
                if (!normalizedRow) return null;
                const similarity = Number(row.similarity ?? row.score);
                const distance = Number(row.distance);
                if (Number.isFinite(similarity)) {
                  normalizedRow.vector_score = similarity;
                } else if (Number.isFinite(distance)) {
                  normalizedRow.vector_score = 1 - distance;
                }
                return normalizedRow;
              })
              .filter(Boolean);

            if (normalized.length > 0) {
              return normalized;
            }
          } else {
            const { payload: errorPayload, text } = await this._readErrorPayload(response);
            const lowerText = `${errorPayload?.message || text || ""}`.toLowerCase();
            if (
              response.status === 404 ||
              /does not exist/.test(lowerText) ||
              /could not find the function/.test(lowerText)
            ) {
              markUnavailable = true;
              break;
            }
          }
        } catch (error) {
          console.warn(`⚠️ Supabase RPC memory lookup failed (${functionName}): ${error.message}`);
        }
      }

      if (markUnavailable) {
        this.unavailableRpcFunctions.add(functionName);
      }
    }

    return [];
  }

  async retrieveRelevantMemories({
    query,
    spaceId = "",
    senderId = "",
    limit = SUPABASE_MEMORY_SEARCH_LIMIT,
  } = {}) {
    const normalizedQuery = toTrimmedString(query);
    if (!normalizedQuery || !this.enabled) {
      return {
        query: normalizedQuery,
        memories: [],
        resolved_locations: [],
        debug: { enabled: this.enabled, vector_rpc_used: false, candidates: 0 },
      };
    }

    const safeLimit = Math.max(1, Math.floor(limit));
    let queryEmbedding = null;
    let rpcMemories = [];
    let recentRows = [];
    try {
      queryEmbedding = await this._createEmbedding(normalizedQuery);
      rpcMemories = await this._searchViaRpc({
        query: normalizedQuery,
        queryEmbedding,
        limit: safeLimit,
        spaceId,
        senderId,
      });
      recentRows = await this._fetchRecentRows();
    } catch (error) {
      console.warn(`⚠️ Memory retrieval fallback triggered: ${error.message}`);
      queryEmbedding = null;
      rpcMemories = [];
      recentRows = await this._fetchRecentRows().catch(() => []);
    }
    const normalizedRows = recentRows.map((row) => this._normalizeMemoryRow(row)).filter(Boolean);

    const deduped = new Map();
    for (const candidate of [...rpcMemories, ...normalizedRows]) {
      const key = toTrimmedString(candidate.id) || `${candidate.created_at}:${candidate.text}`;
      if (!key) continue;
      if (!deduped.has(key)) {
        deduped.set(key, candidate);
        continue;
      }
      const previous = deduped.get(key);
      const previousScore = Number(previous?.vector_score) || 0;
      const nextScore = Number(candidate?.vector_score) || 0;
      if (nextScore > previousScore) {
        deduped.set(key, candidate);
      }
    }

    const allCandidates = [...deduped.values()];
    const scopedCandidates = allCandidates.filter((memory) =>
      this._matchesContext(memory, { spaceId, senderId })
    );
    const pool = scopedCandidates.length > 0 ? scopedCandidates : allCandidates;
    const locationMentions = extractLocationMentions(normalizedQuery);
    const ranked = pool
      .map((memory) => ({
        ...memory,
        score: this._scoreMemory(memory, {
          query: normalizedQuery,
          queryEmbedding,
          locationMentions,
        }),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return (right.created_at || "").localeCompare(left.created_at || "");
      });

    const topMemories = ranked.slice(0, safeLimit);
    const resolvedLocations = resolveLocationsFromMemories({
      locationMentions,
      memories: topMemories,
    });

    return {
      query: normalizedQuery,
      memories: topMemories.map((memory) => ({
        id: memory.id,
        text: memory.text,
        message: memory.message,
        created_at: memory.created_at,
        coordinates: memory.coordinates,
        aliases: memory.aliases,
        score: memory.score,
        source: memory.source,
        agent_id: memory.agent_id,
        event_type: memory.event_type,
      })),
      resolved_locations: resolvedLocations,
      debug: {
        enabled: this.enabled,
        vector_rpc_used: rpcMemories.length > 0,
        candidates: pool.length,
      },
    };
  }

  async buildTaskWithMemoryContext({
    task,
    globalTask = "",
    spaceId = "",
    senderId = "",
    limit = SUPABASE_MEMORY_SEARCH_LIMIT,
  } = {}) {
    const normalizedTask = toTrimmedString(task);
    if (!normalizedTask) {
      return { task: normalizedTask, memory_context: null };
    }

    const query = [normalizedTask, toTrimmedString(globalTask)].filter(Boolean).join(" | ");
    const memoryContext = await this.retrieveRelevantMemories({
      query,
      spaceId,
      senderId,
      limit,
    });
    const enrichedTask = applyMemoryContextToTask({
      task: normalizedTask,
      globalTask,
      memoryContext,
    });

    return {
      task: enrichedTask,
      memory_context: memoryContext,
    };
  }

  async logExplicitMemory({
    text,
    senderId = "",
    spaceId = "",
    runId = null,
    agentId = "foreman",
    role = "foreman",
    source = "user-explicit-log",
  } = {}) {
    const normalizedText = toTrimmedString(text);
    if (!normalizedText) {
      throw new Error("Memory text is required.");
    }

    const coordinates = parseCoordinateTripletFromText(normalizedText);
    const aliases = uniqueStrings(extractLocationAliasesFromText(normalizedText));
    const locationMentions = uniqueStrings(extractLocationMentions(normalizedText));
    const embedding = await this._createEmbedding(normalizedText);
    const createdAt = nowIso();

    const payload = {
      explicit_memory: true,
      source,
      aliases,
      location_mentions: locationMentions,
      ...(coordinates ? { coordinates } : {}),
    };

    const entry = {
      run_id: runId,
      sender_id: senderId || null,
      space_id: spaceId || null,
      agent_id: agentId || "foreman",
      role: role || "foreman",
      event_type: "explicit-memory-log",
      memory_type: "observation",
      message: normalizedText,
      content: normalizedText,
      payload,
      metadata: payload,
      created_at: createdAt,
      ...(embedding ? { embedding } : {}),
    };

    await this.append(entry);
    return {
      text: normalizedText,
      coordinates,
      aliases,
      created_at: createdAt,
    };
  }

  async listRecentMemories({ spaceId = "", senderId = "", limit = 5 } = {}) {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = await this._fetchRecentRows({
      limit: Math.max(safeLimit * 8, 48),
    });
    const normalized = rows.map((row) => this._normalizeMemoryRow(row)).filter(Boolean);
    const scoped = normalized.filter((memory) =>
      this._matchesContext(memory, { spaceId, senderId })
    );
    const pool = scoped.length > 0 ? scoped : normalized;
    return pool.slice(0, safeLimit).map((memory) => ({
      id: memory.id,
      text: memory.text,
      created_at: memory.created_at,
      coordinates: memory.coordinates,
      aliases: memory.aliases,
      event_type: memory.event_type,
      source: memory.source,
    }));
  }
}

function resolveLocationsFromMemories({ locationMentions = [], memories = [] } = {}) {
  const mentions = uniqueStrings(
    ensureArray(locationMentions).map((mention) => normalizeAlias(mention)).filter(Boolean)
  );
  if (!mentions.length) return [];

  const resolved = [];
  const usedMemoryIds = new Set();

  for (const mention of mentions) {
    const best = ensureArray(memories)
      .filter((memory) => memory?.coordinates)
      .filter((memory) => !usedMemoryIds.has(memory.id))
      .map((memory) => {
        const aliasMatches = ensureArray(memory.aliases)
          .map((alias) => normalizeAlias(alias))
          .filter(Boolean);
        const aliasScore = aliasMatches.some(
          (alias) => alias === mention || alias.includes(mention) || mention.includes(alias)
        )
          ? 1
          : 0;
        const textScore = memory.text.toLowerCase().includes(mention) ? 0.5 : 0;
        return {
          memory,
          score: aliasScore + textScore + (Number(memory.score) || 0),
        };
      })
      .sort((left, right) => right.score - left.score)[0];

    if (!best?.memory) continue;
    usedMemoryIds.add(best.memory.id);
    resolved.push({
      mention,
      coordinates: best.memory.coordinates,
      text: best.memory.text,
      memory_id: best.memory.id,
      score: best.score,
      created_at: best.memory.created_at,
    });
  }

  return resolved;
}

function memoryHintLinesForContext({ text, memoryContext }) {
  const hints = [];
  if (!memoryContext) return hints;

  const mentions = extractLocationMentions(text);
  const resolvedLocations = ensureArray(memoryContext.resolved_locations);
  const matchingLocations = resolvedLocations.filter((location) => {
    if (!mentions.length) return true;
    const mention = normalizeAlias(location.mention);
    return mentions.some(
      (candidate) =>
        candidate === mention || candidate.includes(mention) || mention.includes(candidate)
    );
  });

  for (const location of matchingLocations.slice(0, 3)) {
    const coordText = formatCoordinates(location.coordinates);
    if (!coordText) continue;
    hints.push(
      `Location "${location.mention}" resolved from Supabase memory: ${coordText}.`
    );
  }

  if (!hints.length) {
    for (const memory of ensureArray(memoryContext.memories).slice(0, 2)) {
      const summary = summarizeMemoryText(memory.text, 120);
      if (!summary) continue;
      if (memory.coordinates) {
        hints.push(
          `Relevant memory: ${summary} (${formatCoordinates(memory.coordinates)}).`
        );
      } else {
        hints.push(`Relevant memory: ${summary}.`);
      }
    }
  }

  return uniqueStrings(hints);
}

function applyMemoryContextToTask({ task, globalTask = "", memoryContext = null } = {}) {
  let baseTask = toTrimmedString(task).replace(/\s+/g, " ");
  const memoryContextMarker = /Memory MCP context:/i;
  if (memoryContextMarker.test(baseTask)) {
    baseTask = baseTask.split(memoryContextMarker)[0].trim();
  }
  if (!baseTask) return baseTask;
  if (!memoryContext) return baseTask;

  const mentions = extractLocationMentions(
    [baseTask, toTrimmedString(globalTask)].filter(Boolean).join(" ")
  );
  const resolvedLocations = ensureArray(memoryContext.resolved_locations);
  const matching = resolvedLocations.filter((location) => {
    if (!mentions.length) return true;
    const mention = normalizeAlias(location.mention);
    return mentions.some(
      (candidate) =>
        candidate === mention || candidate.includes(mention) || mention.includes(candidate)
    );
  });

  const candidates = (matching.length > 0 ? matching : resolvedLocations)
    .map((location) => {
      const coordText = formatCoordinates(location.coordinates);
      if (!coordText) return "";
      return `${location.mention} ${coordText}`;
    })
    .filter(Boolean)
    .slice(0, 2);

  if (!candidates.length) return baseTask;

  const suffix = ` [memory: ${candidates.join(" | ")}]`;
  const maxTaskLength = 220;
  if (baseTask.length + suffix.length <= maxTaskLength) {
    return `${baseTask}${suffix}`;
  }

  const allowedBaseLength = Math.max(40, maxTaskLength - suffix.length - 3);
  const truncatedBase = `${baseTask.slice(0, allowedBaseLength)}...`;
  return `${truncatedBase}${suffix}`;
}

function summarizeMemoryContextForProposal(memoryContext) {
  if (!memoryContext) return null;

  const resolvedLocations = ensureArray(memoryContext.resolved_locations).map((location) => ({
    mention: location.mention,
    coordinates: location.coordinates,
    created_at: location.created_at,
    text: summarizeMemoryText(location.text, 120),
  }));

  const relevantMemories = ensureArray(memoryContext.memories)
    .slice(0, 5)
    .map((memory) => ({
      text: summarizeMemoryText(memory.text, 160),
      coordinates: memory.coordinates,
      created_at: memory.created_at,
      score: memory.score,
    }));

  if (!resolvedLocations.length && !relevantMemories.length) return null;

  return {
    query: memoryContext.query,
    resolved_locations: resolvedLocations,
    relevant_memories: relevantMemories,
    debug: memoryContext.debug || {},
  };
}

function augmentProposalWithMemoryContext(proposal, memoryContext) {
  if (!proposal || typeof proposal !== "object") return proposal;
  if (!memoryContext) return proposal;

  const memorySummary = summarizeMemoryContextForProposal(memoryContext);
  if (!memorySummary) return proposal;

  const next = {
    ...proposal,
    constraints: uniqueStrings(ensureArray(proposal.constraints)),
    agent_assignments: ensureArray(proposal.agent_assignments).map((assignment) => ({
      ...assignment,
      depends_on: uniqueStrings(assignment.depends_on),
    })),
  };

  const enrichedTask = applyMemoryContextToTask({
    task: next.task,
    globalTask: next.task,
    memoryContext,
  });
  if (enrichedTask && enrichedTask !== next.task) {
    next.task = enrichedTask;
    next.objective = next.objective || next.task;
  }

  next.agent_assignments = next.agent_assignments.map((assignment) => ({
    ...assignment,
    task: applyMemoryContextToTask({
      task: assignment.task,
      globalTask: next.task || proposal.task || "",
      memoryContext,
    }),
  }));

  next.agent_count = next.agent_assignments.length || next.agent_count;
  next.agent_roles = uniqueStrings(next.agent_assignments.map((assignment) => assignment.role));

  const resolvedLines = ensureArray(memorySummary.resolved_locations).map((location) => {
    const coordText = formatCoordinates(location.coordinates);
    return coordText
      ? `memory recall: ${location.mention} -> ${coordText}`
      : `memory recall: ${location.mention}`;
  });
  next.constraints = uniqueStrings([...next.constraints, ...resolvedLines]);
  next.reasoning_summary = `${toTrimmedString(next.reasoning_summary)}${resolvedLines.length > 0 ? " Used Supabase memory recalls for named locations." : " Used Supabase memory context."}`.trim();

  next.handoff = {
    ...next.handoff,
    task: next.task,
    agent_assignments: next.agent_assignments.map((assignment) => ({
      id: assignment.id,
      role: assignment.role,
      task: assignment.task,
      depends_on: uniqueStrings(assignment.depends_on),
    })),
    memory_context: memorySummary,
  };
  next.memory_context = memorySummary;

  return next;
}

const sharedMemoryStore = new SupabaseSharedMemoryStore();

class LocalBotExecutor {
  constructor({ assignment, index, runId, serverPort }) {
    this.assignment = assignment;
    this.index = index;
    this.runId = runId;
    this.agentId = assignment.id;
    this.role = assignment.role;
    this.serverPort = serverPort;
    this.botUsername = buildBotUsername({
      prefix: BOT_NAME_PREFIX,
      role: assignment.role,
      index,
      runId,
    });
    this.ckptDir = path.join(__dirname, `ckpt-${this.botUsername}`);
    this.currentProcess = null;
  }

  async executeTask(task, hooks = {}) {
    const mcReachable = await isTcpReachable(MC_HOST, MC_PORT);
    if (!mcReachable) {
      throw new Error(
        `Minecraft server is unreachable at ${MC_HOST}:${MC_PORT}. Open your 1.19.2 Fabric world to LAN and update VOYAGER_MC_PORT/VOYAGER_MC_HOST if needed.`
      );
    }

    const escapedVoyagerPath = VOYAGER_PATH.replace(/\\/g, "\\\\");
    const escapedCkpt = this.ckptDir.replace(/\\/g, "\\\\");
    const taskLiteral = JSON.stringify(task || "");
    const botLiteral = JSON.stringify(this.botUsername);
    const skipDecompose = Boolean(hooks.skipDecompose);
    const decomposeTimeoutSec = Math.max(
      1,
      Number.isFinite(Number(hooks.decomposeTimeoutSec))
        ? Math.floor(Number(hooks.decomposeTimeoutSec))
        : VOYAGER_DECOMPOSE_TIMEOUT_SEC
    );
    const envRequestTimeoutSec = Math.max(
      30,
      Number.isFinite(Number(hooks.envRequestTimeoutSec))
        ? Math.floor(Number(hooks.envRequestTimeoutSec))
        : VOYAGER_ENV_REQUEST_TIMEOUT
    );

    const pythonScript = [
      "import os",
      "import sys",
      `sys.path.insert(0, ${JSON.stringify(escapedVoyagerPath)})`,
      "from voyager import Voyager",
      "",
      `print('[VOYAGER] Initializing ${this.botUsername}...')`,
      "voyager = Voyager(",
      `    mc_host=${JSON.stringify(MC_HOST)},`,
      `    mc_port=${MC_PORT},`,
      `    server_port=${this.serverPort},`,
      `    bot_username=${botLiteral},`,
      "    openai_api_key=os.getenv('OPENAI_API_KEY'),",
      `    ckpt_dir=${JSON.stringify(escapedCkpt)},`,
      `    env_request_timeout=${envRequestTimeoutSec},`,
      "    resume=False,",
      ")",
      `task = ${taskLiteral}`,
      `skip_decompose = ${skipDecompose ? "True" : "False"}`,
      `decompose_timeout_sec = ${decomposeTimeoutSec}`,
      `reset_env_between_sub_goals = ${VOYAGER_RESET_ENV_BETWEEN_SUBGOALS ? "True" : "False"}`,
      "print(f'[VOYAGER] Task: {task}')",
      "try:",
      "    if skip_decompose:",
      "        print('[VOYAGER] Skipping task decomposition for this run; using direct goal.')",
      "        sub_goals = [task]",
      "    else:",
      "        print('[VOYAGER] Decomposing task...')",
      "        try:",
      "            import signal",
      "            class _DecomposeTimeout(Exception):",
      "                pass",
      "            def _decompose_alarm_handler(signum, frame):",
      "                raise _DecomposeTimeout('decompose timeout reached')",
      "            signal.signal(signal.SIGALRM, _decompose_alarm_handler)",
      "            signal.alarm(max(1, int(decompose_timeout_sec)))",
      "            try:",
      "                sub_goals = voyager.decompose_task(task=task)",
      "            finally:",
      "                signal.alarm(0)",
      "            print(f'[VOYAGER] Sub-goals: {sub_goals}')",
      "        except Exception as decompose_error:",
      "            print(f'[VOYAGER] Decompose failed, falling back to direct goal: {decompose_error}')",
      "            sub_goals = [task]",
      "    print('[VOYAGER] Executing in Minecraft...')",
      "    voyager.inference(sub_goals=sub_goals, reset_env=reset_env_between_sub_goals)",
      "    print('[VOYAGER] Task completed successfully!')",
      "except Exception as e:",
      "    print(f'[VOYAGER] Error: {e}')",
      "    sys.exit(1)",
      "",
    ].join("\n");

    fs.mkdirSync(this.ckptDir, { recursive: true });
    const tempFile = path.join(__dirname, `temp_voyager_${this.agentId}_${Date.now()}.py`);
    fs.writeFileSync(tempFile, pythonScript);

    return new Promise((resolve, reject) => {
      this.currentProcess = spawn(PYTHON_BIN, [tempFile], {
        cwd: VOYAGER_PATH,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      if (hooks.onProcessStart) {
        hooks.onProcessStart(this.currentProcess);
      }

      let stdout = "";
      let stderr = "";
      let lastVoyagerErrorLine = "";

      this.currentProcess.stdout.on("data", async (chunk) => {
        const text = chunk.toString();
        stdout += text;
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (line.includes("[VOYAGER] Error:")) {
            lastVoyagerErrorLine = line;
          }
          if (hooks.onStatus) {
            await hooks.onStatus(line);
          }
        }
      });

      this.currentProcess.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      this.currentProcess.on("error", (error) => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        this.currentProcess = null;
        reject(error);
      });

      this.currentProcess.on("close", (code) => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        this.currentProcess = null;

        if (hooks.onProcessExit) {
          hooks.onProcessExit(code);
        }

        if (code === 0) {
          resolve({ success: true, stdout, stderr });
          return;
        }

        const stderrTail = stderr.trim().slice(-1200);
        const stdoutTail = stdout.trim().slice(-1200);
        const diagnostics = [];
        if (lastVoyagerErrorLine) diagnostics.push(lastVoyagerErrorLine);
        if (stderrTail) diagnostics.push(`STDERR: ${stderrTail}`);
        if (stdoutTail) diagnostics.push(`STDOUT: ${stdoutTail}`);
        const diagnostic = diagnostics.join(" | ") || `exit code ${code}`;
        const error = new Error(
          `Agent ${this.agentId} (${this.botUsername}) exited with ${code}. ${diagnostic}`
        );
        error.transientHint = isTransientAgentFailure(
          `${lastVoyagerErrorLine}\n${stderrTail}\n${stdoutTail}`
        );
        reject(error);
      });
    });
  }
}

class LocalOrchestrationAgent {
  constructor(run) {
    this.run = run;
    this.executors = new Map();
    this.usedServerPorts = new Set();
  }

  async getExecutor(assignment, index) {
    if (!this.executors.has(assignment.id)) {
      const serverPort = await findAvailablePort(
        BASE_SERVER_PORT + index,
        this.usedServerPorts
      );
      this.executors.set(
        assignment.id,
        new LocalBotExecutor({
          assignment,
          index,
          runId: this.run.id,
          serverPort,
        })
      );
    }
    return this.executors.get(assignment.id);
  }

  async runPlan(assignments) {
    const pending = new Map(assignments.map((assignment, index) => [assignment.id, { assignment, index }]));
    const completed = new Set();

    while (pending.size > 0) {
      if (this.run.cancelRequested) {
        throw new Error("Run cancelled");
      }

      const ready = [];
      for (const [id, value] of pending.entries()) {
        const deps = value.assignment.depends_on || [];
        const depsDone = deps.every((depId) => completed.has(depId));
        if (depsDone) ready.push({ id, ...value });
      }

      if (ready.length === 0) {
        throw new Error("Unable to resolve agent dependencies. Check depends_on references.");
      }

      recordRunEvent(this.run, {
        type: "stage-start",
        message: `Starting ${ready.length} parallel agent(s): ${ready.map((r) => r.assignment.id).join(", ")}`,
      });

      await Promise.all(
        ready.map(async ({ id, assignment, index }, readyIndex) => {
          if (AGENT_START_STAGGER_MS > 0 && readyIndex > 0) {
            await sleep(AGENT_START_STAGGER_MS * readyIndex);
          }
          await this.runAssignment(assignment, index);
          completed.add(id);
          pending.delete(id);
        })
      );
    }
  }

  async runAssignment(assignment, index) {
    if (this.run.cancelRequested) {
      throw new Error("Run cancelled");
    }

    const executor = await this.getExecutor(assignment, index);
    let effectiveAssignment = { ...assignment };

    try {
      const enriched = await sharedMemoryStore.buildTaskWithMemoryContext({
        task: assignment.task,
        globalTask: this.run.task || assignment.task || "",
        spaceId: this.run.spaceId,
        senderId: this.run.senderId,
        limit: SUPABASE_MEMORY_SEARCH_LIMIT,
      });

      if (enriched?.task && enriched.task !== assignment.task) {
        effectiveAssignment.task = enriched.task;
        const assignmentIndex = this.run.agentAssignments.findIndex(
          (candidate) => candidate.id === assignment.id
        );
        if (assignmentIndex >= 0) {
          this.run.agentAssignments[assignmentIndex] = {
            ...this.run.agentAssignments[assignmentIndex],
            task: effectiveAssignment.task,
          };
          persistRun(this.run);
        }

        recordRunEvent(this.run, {
          type: "memory-context-applied",
          agent: assignment.id,
          role: assignment.role,
          message: `Applied Supabase Memory MCP context to ${assignment.id} task.`,
          data: {
            original_task: assignment.task,
            enriched_task: effectiveAssignment.task,
            resolved_locations: enriched?.memory_context?.resolved_locations || [],
          },
        });
      }
    } catch (error) {
      recordRunEvent(this.run, {
        type: "memory-context-error",
        agent: assignment.id,
        role: assignment.role,
        message: `Memory context lookup failed for ${assignment.id}: ${error.message}`,
      });
    }

    recordRunEvent(this.run, {
      type: "agent-start",
      agent: effectiveAssignment.id,
      role: effectiveAssignment.role,
      message: `Agent ${effectiveAssignment.id} (${effectiveAssignment.role}) starting task: ${effectiveAssignment.task}`,
      data: {
        bot_username: executor.botUsername,
        server_port: executor.serverPort,
        ckpt_dir: executor.ckptDir,
      },
    });

    const maxAttempts = 1 + AGENT_TRANSIENT_RESTARTS;
    let lastError = null;
    const skipDecompose =
      VOYAGER_SKIP_DECOMPOSE_FOR_MULTI_AGENT &&
      Number(this.run.agentCount || 0) > 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptLabel = `attempt ${attempt}/${maxAttempts}`;
      if (attempt > 1) {
        recordRunEvent(this.run, {
          type: "agent-retry",
          agent: effectiveAssignment.id,
          role: effectiveAssignment.role,
          message: `Restarting agent ${effectiveAssignment.id} (${attemptLabel}) after transient failure.`,
        });
      }

      try {
        if (skipDecompose && attempt === 1) {
          recordRunEvent(this.run, {
            type: "agent-decompose-skipped",
            agent: effectiveAssignment.id,
            role: effectiveAssignment.role,
            message: `Skipping decompose for ${effectiveAssignment.id} in multi-agent mode.`,
            data: {
              run_agent_count: this.run.agentCount,
              timeout_sec: VOYAGER_DECOMPOSE_TIMEOUT_SEC,
            },
          });
        }
        await executor.executeTask(effectiveAssignment.task, {
          skipDecompose,
          decomposeTimeoutSec: VOYAGER_DECOMPOSE_TIMEOUT_SEC,
          envRequestTimeoutSec: VOYAGER_ENV_REQUEST_TIMEOUT,
          onProcessStart: (child) => {
            this.run.children[effectiveAssignment.id] = child;
            recordRunEvent(this.run, {
              type: "agent-process-started",
              agent: effectiveAssignment.id,
              role: effectiveAssignment.role,
              message: `Agent ${effectiveAssignment.id} process started (pid ${child.pid || "n/a"}, ${attemptLabel}).`,
              data: {
                pid: child.pid || null,
                bot_username: executor.botUsername,
                server_port: executor.serverPort,
                attempt,
              },
            });
          },
          onProcessExit: (code) => {
            delete this.run.children[effectiveAssignment.id];
            recordRunEvent(this.run, {
              type: "agent-process-exit",
              agent: effectiveAssignment.id,
              role: effectiveAssignment.role,
              message: `Agent ${effectiveAssignment.id} process exited with code ${code} (${attemptLabel}).`,
              data: { code, attempt },
            });
          },
          onStatus: async (line) => {
            recordRunEvent(this.run, {
              type: "agent-status",
              agent: effectiveAssignment.id,
              role: effectiveAssignment.role,
              message: line,
            });
          },
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const transient =
          error?.transientHint === true || isTransientAgentFailure(error?.message || "");
        const canRetry = transient && attempt < maxAttempts;
        recordRunEvent(this.run, {
          type: "agent-error",
          agent: effectiveAssignment.id,
          role: effectiveAssignment.role,
          message: `Agent ${effectiveAssignment.id} failed (${attemptLabel}): ${error.message}`,
          data: { transient, can_retry: canRetry, attempt },
        });
        if (!canRetry) {
          throw error;
        }
        await sleep(AGENT_TRANSIENT_RESTART_DELAY_MS * attempt);
      }
    }

    if (lastError) {
      throw lastError;
    }

    recordRunEvent(this.run, {
      type: "agent-complete",
      agent: effectiveAssignment.id,
      role: effectiveAssignment.role,
      message: `Agent ${effectiveAssignment.id} completed successfully.`,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientAgentFailure(message) {
  const lower = `${message || ""}`.toLowerCase();
  return [
    "connection aborted",
    "remote end closed connection",
    "without response",
    "remotedisconnected",
    "server disconnected",
    "server disconnect",
    "connection reset by peer",
    "connection closed",
    "read timed out",
    "timed out",
    "timeout",
    "temporarily unavailable",
    "service unavailable",
    "rate limit",
    "too many requests",
    "throttled",
    "please wait before reconnecting",
  ].some((token) => lower.includes(token));
}

function nowIso() {
  return new Date().toISOString();
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port);
  });
}

async function findAvailablePort(startPort, usedPorts = new Set(), maxScan = 200) {
  for (let offset = 0; offset < maxScan; offset += 1) {
    const candidate = startPort + offset;
    if (usedPorts.has(candidate)) continue;
    // eslint-disable-next-line no-await-in-loop
    const free = await isPortFree(candidate);
    if (free) {
      usedPorts.add(candidate);
      return candidate;
    }
  }
  throw new Error(
    `Unable to find an available mineflayer bridge port from ${startPort} (scanned ${maxScan}).`
  );
}

function isTcpReachable(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (error) {}
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseExplicitAgentCountFromText(text) {
  const raw = `${text || ""}`.trim().toLowerCase();
  if (!raw) return 0;

  let maxCount = 0;
  const updateMax = (value) => {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.floor(value));
    if (next > maxCount) maxCount = next;
  };

  const numericMatches = [...raw.matchAll(/\b(\d+)\s*(?:bot|bots|agent|agents|worker|workers)\b/g)];
  for (const match of numericMatches) {
    updateMax(Number(match[1]));
  }

  const wordCounts = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
  };
  const wordMatches = [
    ...raw.matchAll(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?:bot|bots|agent|agents|worker|workers)\b/g
    ),
  ];
  for (const match of wordMatches) {
    updateMax(wordCounts[match[1]] || 0);
  }

  const indefiniteMentions = [
    ...raw.matchAll(/\b(?:an?|another)\s+(?:bot|agent|worker)\b/g),
  ].length;
  if (indefiniteMentions > 0) {
    updateMax(indefiniteMentions);
  }

  const explicitRoleOnes = [...raw.matchAll(/\bone\s+(?:miner|builder|forager)\b/g)].length;
  if (explicitRoleOnes >= 2) {
    updateMax(explicitRoleOnes);
  }

  if (/\b(multiple|several)\s+(bots?|agents?|workers?)\b/.test(raw)) {
    updateMax(2);
  }
  if (/\b(in\s+parallel|parallel agents?|parallel bots?)\b/.test(raw)) {
    updateMax(2);
  }

  return maxCount;
}

function isLikelyAgentStartRequestText(text) {
  const lower = `${text || ""}`.toLowerCase();
  if (!lower) return false;
  const hasAgentWord = /\b(?:bot|bots|agent|agents|worker|workers)\b/.test(lower);
  const hasActionVerb =
    /\b(?:start|spawn|launch|run|create|make|farm|collect|gather|mine|build|chop)\b/.test(lower);
  return hasAgentWord && hasActionVerb;
}

function extractAgentTasksFromText(text, maxCount = MAX_EXPLICIT_AGENT_COUNT) {
  const normalized = toTrimmedString(text).replace(/\s+/g, " ");
  if (!normalized) return [];

  let segmented = ` ${normalized} `;
  segmented = segmented.replace(
    /\s+(?:and\s+then|then|and)\s+(?=(?:start|spawn|launch|run|create|make)\b)/gi,
    " ||| "
  );
  segmented = segmented.replace(
    /\s+(?:and\s+then|then|and)\s+(?=(?:a|an|another|first|second|third|fourth|fifth|\d+|one|two|three|four|five|six)\s+(?:bot|agent|worker)\b)/gi,
    " ||| "
  );

  const segments = segmented
    .split("|||")
    .map((part) => part.trim())
    .filter(Boolean);
  const tasks = [];

  for (const segment of segments) {
    if (!/\b(?:bot|agent|worker)\b/i.test(segment)) continue;
    const marker = segment.match(/\b(?:to|for)\b\s+(.+)$/i);
    if (!marker?.[1]) continue;

    const task = marker[1]
      .trim()
      .replace(/^(?:please|go)\s+/i, "")
      .replace(/[.?!]+$/g, "")
      .trim();
    if (!task) continue;
    tasks.push(task);
  }

  const uniqueTasks = uniqueStrings(tasks);
  if (uniqueTasks.length === 0) {
    const pluralTaskMatch = normalized.match(
      /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:bots?|agents?|workers?)\s+(?:to|for)\s+(.+)$/i
    );
    if (pluralTaskMatch?.[1]) {
      const fallbackTask = pluralTaskMatch[1]
        .trim()
        .replace(/[.?!]+$/g, "")
        .trim();
      if (fallbackTask) {
        return [fallbackTask].slice(
          0,
          Math.max(1, Math.floor(maxCount || MAX_EXPLICIT_AGENT_COUNT))
        );
      }
    }
    return [];
  }
  return uniqueTasks.slice(0, Math.max(1, Math.floor(maxCount || MAX_EXPLICIT_AGENT_COUNT)));
}

function getRequestedAgentLimitFromConversation(conversation) {
  const entries = ensureArray(conversation);
  let requested = 0;
  for (const item of entries) {
    const text =
      typeof item === "string"
        ? item
        : typeof item?.text === "string"
          ? item.text
          : "";
    requested = Math.max(requested, parseExplicitAgentCountFromText(text));
  }
  if (requested > 1) {
    return Math.min(requested, MAX_EXPLICIT_AGENT_COUNT);
  }
  return MAX_IMPLICIT_AGENT_COUNT;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of ensureArray(values)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }

  return result;
}

function explicitWorkerRole(text) {
  const lower = `${text || ""}`.toLowerCase();

  if (/\bminer\b/.test(lower)) return "miner";
  if (/\bbuilder\b/.test(lower)) return "builder";
  if (/\bforager\b/.test(lower)) return "forager";
  return null;
}

function inferWorkerRoleFromTask(taskHint = "", index = 0) {
  const lower = `${taskHint || ""}`.toLowerCase();

  if (/\b(storage|chest|build|shelter|hut|base|smelt|furnace)\b/.test(lower)) {
    return "builder";
  }

  if (/\b(mine|ore|iron|coal|torch|pickaxe|stone|cobblestone)\b/.test(lower)) {
    return "miner";
  }

  if (/\b(dirt|sand|gravel|clay|material)\b/.test(lower)) {
    return index % 2 === 0 ? "builder" : "miner";
  }

  if (/\b(food|farm|harvest|wheat|animal|wood|log|tree|scout|explore)\b/.test(lower)) {
    return "forager";
  }

  return null;
}

function canonicalizeWorkerRole(roleHint, taskHint = "", fallback = "builder", index = 0) {
  const explicit = explicitWorkerRole(roleHint);
  if (explicit) return explicit;

  const inferred = inferWorkerRoleFromTask(
    `${roleHint || ""} ${taskHint || ""}`.trim(),
    index
  );
  if (inferred) return inferred;

  return CANONICAL_WORKER_ROLES.includes(fallback) ? fallback : "builder";
}

function normalizePriority(value) {
  return ["low", "normal", "high"].includes(value) ? value : "normal";
}

function truncate(value, max = 140) {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function toRelativeTrackingPath(filePath) {
  return path.relative(process.cwd(), filePath) || filePath;
}

function ensureTrackingDirectories() {
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function acquireProcessLock() {
  fs.mkdirSync(PHOTON_TRACKING_DIR, { recursive: true });
  if (fs.existsSync(PROCESS_LOCK_PATH)) {
    try {
      const raw = fs.readFileSync(PROCESS_LOCK_PATH, "utf8");
      const existing = JSON.parse(raw);
      const lockedPid = Number(existing?.pid);
      if (processExists(lockedPid)) {
        throw new Error(
          `Another Photon instance is already running (pid ${lockedPid}). Stop it before starting a new one.`
        );
      }
    } catch (error) {
      if (
        error?.message &&
        error.message.includes("Another Photon instance is already running")
      ) {
        throw error;
      }
      // stale or corrupt lock; overwrite below
    }
  }

  fs.writeFileSync(
    PROCESS_LOCK_PATH,
    JSON.stringify({ pid: process.pid, started_at: nowIso() }, null, 2)
  );
}

function releaseProcessLock() {
  try {
    if (!fs.existsSync(PROCESS_LOCK_PATH)) return;
    const raw = fs.readFileSync(PROCESS_LOCK_PATH, "utf8");
    const current = JSON.parse(raw);
    if (Number(current?.pid) === process.pid) {
      fs.unlinkSync(PROCESS_LOCK_PATH);
    }
  } catch (error) {
    // best effort cleanup
  }
}

function getSpaceRunIds(spaceId) {
  if (!spaceRuns.has(spaceId)) {
    spaceRuns.set(spaceId, new Set());
  }
  return spaceRuns.get(spaceId);
}

function registerRunForSpace(spaceId, runId) {
  getSpaceRunIds(spaceId).add(runId);
}

function getLatestActiveRunForSpace(spaceId) {
  const candidates = [...getSpaceRunIds(spaceId)]
    .map((runId) => allRuns.get(runId))
    .filter((run) => run && run.spaceId === spaceId && activeRuns.has(run.id) && !run.finalized);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return candidates[0];
}

function isAffirmative(text) {
  return /^(yes|y|yeah|yep|confirm|confirmed|approve|approved|launch|go|go ahead|do it|looks good|sounds good)[.! ]*$/i.test(
    text.trim()
  );
}

function normalizeTapbackKind(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return null;

  if (["love", "loved", "heart", "hearted"].includes(normalized)) return "love";
  if (
    [
      "like",
      "liked",
      "thumbsup",
      "thumbs-up",
      "thumbs_up",
      "thumbs up",
      "+1",
      "upvote",
    ].includes(normalized)
  ) {
    return "like";
  }
  if (["dislike", "disliked", "thumbsdown", "thumbs down", "thumbs_down", "thumbs-down"].includes(normalized)) {
    return "dislike";
  }
  if (["laugh", "laughed"].includes(normalized)) return "laugh";
  if (["emphasize", "emphasized", "emphasis"].includes(normalized)) return "emphasize";
  if (["question", "questioned"].includes(normalized)) return "question";
  if (["emoji"].includes(normalized)) return "emoji";
  if (["sticker"].includes(normalized)) return "sticker";
  return null;
}

function parseAssociatedReactionType(value) {
  const raw = toTrimmedString(value);
  if (!raw) return null;

  const match = raw.match(/([23]00[0-7])/);
  const maybeCode = match ? Number(match[1]) : Number(raw);
  if (!Number.isFinite(maybeCode)) return null;

  let code = maybeCode;
  let isRemoved = false;
  if (code >= 3000 && code <= 3007) {
    code -= 1000;
    isRemoved = true;
  }

  const kindByCode = {
    2000: "love",
    2001: "like",
    2002: "dislike",
    2003: "laugh",
    2004: "emphasize",
    2005: "question",
    2006: "emoji",
    2007: "sticker",
  };
  const kind = kindByCode[code] || null;
  if (!kind) return null;
  return { kind, isRemoved };
}

function normalizeEmojiSignal(text) {
  return `${text || ""}`
    .trim()
    .replace(/\uFE0F/gu, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
}

function isAffirmativeReactionEmoji(text) {
  const normalized = normalizeEmojiSignal(text);
  return normalized === "👍" || normalized === "❤" || normalized === "♥";
}

function isAffirmativeReactionText(text) {
  const normalized = toTrimmedString(text);
  if (!normalized) return false;
  if (isAffirmativeReactionEmoji(normalized)) return true;
  // Local iMessage tapbacks can surface as plain text rows like "Loved ..."/"Liked ...".
  return /^(loved|liked)\b/i.test(normalized);
}

function extractReactionSignalFromCustomRaw(raw, depth = 0) {
  if (!raw || depth > 5) return null;

  if (typeof raw === "string") {
    const parsed = safeParseJsonObject(raw);
    if (!parsed) return null;
    return extractReactionSignalFromCustomRaw(parsed, depth + 1);
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const nested = extractReactionSignalFromCustomRaw(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  if (typeof raw !== "object") return null;

  let kind = null;
  let isRemoved = false;
  let emoji = "";

  const reaction = raw.reaction;
  if (typeof reaction === "string") {
    kind = normalizeTapbackKind(reaction);
  } else if (reaction && typeof reaction === "object") {
    kind =
      normalizeTapbackKind(reaction.kind) ||
      normalizeTapbackKind(reaction.type) ||
      normalizeTapbackKind(reaction.reaction);
    isRemoved = Boolean(reaction.isRemoved ?? reaction.removed ?? reaction.is_removed);
    emoji = toTrimmedString(reaction.emoji || reaction.value);
  }

  if (!kind) {
    kind =
      normalizeTapbackKind(raw.kind) ||
      normalizeTapbackKind(raw.reactionKind) ||
      normalizeTapbackKind(raw.reaction_type) ||
      normalizeTapbackKind(raw.tapback) ||
      normalizeTapbackKind(raw.tapbackType);
  }

  if (!emoji) {
    emoji = toTrimmedString(raw.emoji || raw.associatedMessageEmoji || raw.associated_message_emoji);
  }

  if (!kind) {
    const associated = parseAssociatedReactionType(
      raw.associatedMessageType ?? raw.associated_message_type
    );
    if (associated) {
      kind = associated.kind;
      isRemoved = isRemoved || associated.isRemoved;
    }
  }

  if (!kind) {
    const updateType = toTrimmedString(raw.updateType || raw.update_type).toLowerCase();
    if (updateType === "reaction") {
      const associatedFromMessage = parseAssociatedReactionType(
        raw.message?.associatedMessageType ?? raw.message?.associated_message_type
      );
      if (associatedFromMessage) {
        kind = associatedFromMessage.kind;
        isRemoved = isRemoved || associatedFromMessage.isRemoved;
      }
      if (!kind) {
        kind =
          normalizeTapbackKind(raw.message?.reaction) ||
          normalizeTapbackKind(raw.message?.kind) ||
          normalizeTapbackKind(raw.message?.reactionKind);
      }
      if (!emoji) {
        emoji = toTrimmedString(raw.message?.associatedMessageEmoji || raw.message?.emoji);
      }
    }
  }

  if (kind) return { kind, isRemoved, emoji };

  for (const key of ["message", "payload", "data", "event", "raw", "meta", "metadata"]) {
    const nested = extractReactionSignalFromCustomRaw(raw[key], depth + 1);
    if (nested) return nested;
  }

  return null;
}

function extractAffirmativeReactionApproval(message) {
  if (!message || typeof message !== "object") return null;

  if (message.content?.type === "text") {
    return isAffirmativeReactionText(message.content.text)
      ? { source: "text", kind: "like" }
      : null;
  }

  if (message.content?.type !== "custom") return null;

  const signal = extractReactionSignalFromCustomRaw(message.content.raw);
  if (!signal || signal.isRemoved) return null;

  if (signal.kind === "love" || signal.kind === "like") {
    return { source: "custom", kind: signal.kind };
  }

  if (signal.kind === "emoji" && isAffirmativeReactionEmoji(signal.emoji)) {
    return { source: "custom", kind: "emoji" };
  }

  return null;
}

function isNegativeOnly(text) {
  return /^(no|n|nope|nah|not yet|wait|hold on)[.! ]*$/i.test(text.trim());
}

function normalizeUserTextForSignature(text) {
  return `${text || ""}`.trim().replace(/\s+/g, " ").toLowerCase();
}

function isDuplicateRecentMessage({ senderId, spaceId, text, windowMs = 15000 }) {
  const normalized = normalizeUserTextForSignature(text);
  if (!normalized) return false;
  const signature = `${senderId}|${spaceId}|${normalized}`;
  const now = Date.now();
  const previous = recentMessageSignatures.get(signature);
  recentMessageSignatures.set(signature, now);

  for (const [key, ts] of recentMessageSignatures.entries()) {
    if (now - ts > 60000) recentMessageSignatures.delete(key);
  }

  return typeof previous === "number" && now - previous < windowMs;
}

function isNewAgentRequestText(text) {
  const lower = `${text || ""}`.trim().toLowerCase();
  return (
    /^\/new\b/.test(lower) ||
    /^(new agent|start new agent|replace agent|switch agent)\b/.test(lower)
  );
}

function isEndSessionText(text) {
  return /^(?:\/end|end|stop|done|exit|quit|all done|that'?s all|no thanks|no thank you|end session)[.! ]*$/i.test(
    `${text || ""}`.trim()
  );
}

function parseAgentOverrideRequest(text) {
  const trimmed = `${text || ""}`.trim();
  if (!trimmed) return null;

  let body = "";
  if (/^\/override\b/i.test(trimmed)) {
    body = trimmed.replace(/^\/override\b[:\s-]*/i, "").trim();
  } else if (/^(override agent|agent override|override to)\b/i.test(trimmed)) {
    body = trimmed
      .replace(/^(override agent|agent override|override to)\b(?:\s+to)?[:\s-]*/i, "")
      .trim();
  } else {
    return null;
  }

  if (!body) {
    return { mode: null, role: null, assignmentId: null, task: "" };
  }

  const explicitAssignmentMatch = body.match(/^(?:assignment|agent)\s+([a-z0-9_-]+)\b/i);
  if (explicitAssignmentMatch) {
    const assignmentId = explicitAssignmentMatch[1];
    const task = body
      .slice(explicitAssignmentMatch[0].length)
      .replace(/^(?:for|on|task)\b[:\s-]*/i, "")
      .trim();
    return { mode: "assignment", role: null, assignmentId, task };
  }

  const roleMatch = body.match(/^(miner|builder|forager)\b/i);
  if (!roleMatch) {
    const genericAssignmentMatch = body.match(/^([a-z0-9_-]+)\b/i);
    if (genericAssignmentMatch) {
      const assignmentId = genericAssignmentMatch[1];
      const task = body
        .slice(genericAssignmentMatch[0].length)
        .replace(/^(?:for|on|task)\b[:\s-]*/i, "")
        .trim();
      return { mode: "assignment", role: null, assignmentId, task };
    }
    return { mode: null, role: null, assignmentId: null, task: body };
  }

  const role = roleMatch[1].toLowerCase();
  const task = body
    .slice(roleMatch[0].length)
    .replace(/^(?:for|on|task)\b[:\s-]*/i, "")
    .trim();

  return { mode: "role", role, assignmentId: null, task };
}

function extractTaskFromNewAgentText(text) {
  const trimmed = `${text || ""}`.trim();
  if (!trimmed) return "";
  if (/^\/new\b/i.test(trimmed)) {
    return trimmed.replace(/^\/new\b[:\s-]*/i, "").trim();
  }
  return trimmed
    .replace(/^(new agent|start new agent|replace agent|switch agent)\b[:\s-]*/i, "")
    .trim();
}

function serializeProposalSummary(state) {
  return {
    proposal_id: state.id,
    status: state.status,
    revision: state.revision,
    task: state.proposal.task,
    agent_count: state.proposal.agent_count,
    agent_roles: state.proposal.agent_roles,
    updated_at: state.updatedAt,
    tracking_path: toRelativeTrackingPath(state.filePath),
  };
}

function serializeRunSummary(run) {
  return {
    run_id: run.id,
    status: run.status,
    task: run.task,
    agent_count: run.agentCount,
    agent_roles: run.agentRoles,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    latest_message: run.latestMessage,
    tracking_path: toRelativeTrackingPath(run.filePath),
  };
}

function updateTrackerIndex() {
  const pending = [...pendingApprovals.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(serializeProposalSummary);

  const runs = [...allRuns.values()]
    .sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt;
      const bTime = b.updatedAt || b.createdAt;
      return bTime.localeCompare(aTime);
    })
    .slice(0, 50)
    .map(serializeRunSummary);

  writeJsonFile(TRACKER_INDEX_PATH, {
    updated_at: nowIso(),
    pending_proposals: pending,
    runs,
  });
}

function normalizeAssignment(assignment, index, defaults) {
  const fallbackRole =
    inferWorkerRoleFromTask(
      typeof assignment?.task === "string" && assignment.task.trim()
        ? assignment.task.trim()
        : defaults.task || "",
      index
    ) ||
    defaults.roles[index] ||
    defaults.roles[0] ||
    "builder";

  const role = canonicalizeWorkerRole(
    typeof assignment?.role === "string" ? assignment.role.trim() : "",
    typeof assignment?.task === "string" && assignment.task.trim()
      ? assignment.task.trim()
      : defaults.task || "",
    fallbackRole,
    index
  );

  const task =
    typeof assignment?.task === "string" && assignment.task.trim()
      ? assignment.task.trim()
      : defaults.task || `Handle ${role} work for the overall request.`;

  return {
    id:
      typeof assignment?.id === "string" && assignment.id.trim()
        ? assignment.id.trim()
        : `agent-${index + 1}`,
    role,
    task,
    depends_on: uniqueStrings(assignment?.depends_on),
    deliverable:
      typeof assignment?.deliverable === "string" && assignment.deliverable.trim()
        ? assignment.deliverable.trim()
        : `Update for ${role}`,
    success_signal:
      typeof assignment?.success_signal === "string" && assignment.success_signal.trim()
        ? assignment.success_signal.trim()
        : `Task completed by ${role}`,
    priority: normalizePriority(assignment?.priority || defaults.priority),
  };
}

function normalizeProposal(raw, context) {
  const latestUserText = latestConversationText(context?.conversation);
  const explicitRequestedAgentCount = parseExplicitAgentCountFromText(latestUserText);
  const explicitStartIntent = isLikelyAgentStartRequestText(latestUserText);
  const requestedAgentLimit = getRequestedAgentLimitFromConversation(
    context?.conversation
  );
  const rawAssignments = ensureArray(raw?.agent_assignments);
  const rawRoles = uniqueStrings(raw?.agent_roles);
  const rolesFromAssignments = rawAssignments
    .map((assignment) =>
      typeof assignment?.role === "string" ? assignment.role.trim() : ""
    )
    .filter(Boolean);

  let task =
    typeof raw?.task === "string" && raw.task.trim() ? raw.task.trim() : null;
  let roles = uniqueStrings(
    [...rawRoles, ...rolesFromAssignments].map((role, index) =>
      canonicalizeWorkerRole(
        role,
        rawAssignments[index]?.task || task || "",
        inferWorkerRoleFromTask(rawAssignments[index]?.task || task || "", index) ||
          "builder",
        index
      )
    )
  );

  if (roles.length === 0 && task) {
    roles = [canonicalizeWorkerRole("", task, inferWorkerRoleFromTask(task, 0) || "builder", 0)];
  }

  let assignments = rawAssignments.map((assignment, index) =>
    normalizeAssignment(assignment, index, {
      roles,
      task,
      priority: normalizePriority(raw?.priority),
    })
  );

  if (assignments.length === 0 && roles.length > 0) {
    assignments = roles.map((role, index) =>
      normalizeAssignment({ role }, index, {
        roles,
        task,
        priority: normalizePriority(raw?.priority),
      })
    );
  }

  let usedTextTaskFallback = false;
  if (!task || assignments.length === 0 || assignments.every((assignment) => !assignment.task?.trim())) {
    const inferredTasks = extractAgentTasksFromText(latestUserText, requestedAgentLimit);
    const inferredCount =
      explicitRequestedAgentCount > 1
        ? Math.min(explicitRequestedAgentCount, requestedAgentLimit)
        : 0;

    let textDerivedTasks = inferredTasks;
    if (inferredCount > 1 && inferredTasks.length === 1) {
      textDerivedTasks = Array.from({ length: inferredCount }, () => inferredTasks[0]);
    }

    if (textDerivedTasks.length > 0) {
      assignments = textDerivedTasks.map((taskText, index) =>
        normalizeAssignment({ task: taskText }, index, {
          roles,
          task: taskText,
          priority: normalizePriority(raw?.priority),
        })
      );
      task =
        textDerivedTasks.length === 1
          ? textDerivedTasks[0]
          : `Coordinate ${textDerivedTasks.length} agent tasks: ${textDerivedTasks.join("; ")}`;
      roles = uniqueStrings(assignments.map((assignment) => assignment.role));
      usedTextTaskFallback = true;
    }
  }

  const requestedAgentCount = Number(raw?.agent_count);
  let agentCount = Number.isFinite(requestedAgentCount)
    ? Math.max(0, Math.floor(requestedAgentCount))
    : 0;

  if (assignments.length > agentCount) {
    agentCount = assignments.length;
  }
  if (!agentCount && roles.length > 0) {
    agentCount = roles.length;
  }
  if (!agentCount && task) {
    agentCount = 1;
  }

  if (task && agentCount === 0) {
    agentCount = 1;
  }

  if (agentCount > requestedAgentLimit) {
    agentCount = requestedAgentLimit;
  }

  while (task && assignments.length < agentCount) {
    assignments.push(
      normalizeAssignment({}, assignments.length, {
        roles,
        task,
        priority: normalizePriority(raw?.priority),
      })
    );
  }

  if (assignments.length > agentCount) {
    assignments = assignments.slice(0, agentCount);
  }

  if (task && assignments.length === 0) {
    assignments = [
      normalizeAssignment({}, 0, {
        roles,
        task,
        priority: normalizePriority(raw?.priority),
      }),
    ];
  }

  const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
  assignments = assignments.map((assignment) => ({
    ...assignment,
    depends_on: ensureArray(assignment.depends_on).filter(
      (depId) => depId !== assignment.id && assignmentIds.has(depId)
    ),
  }));

  if (roles.length === 0 && assignments.length > 0) {
    roles = uniqueStrings(assignments.map((assignment) => assignment.role));
  }

  if (assignments.length > 0) {
    roles = uniqueStrings(assignments.map((assignment) => assignment.role));
  }

  if (task) {
    agentCount = assignments.length || 1;
  }

  const hasRunnablePlan = Boolean(task) && assignments.length > 0;
  const startAgentOrchestration =
    hasRunnablePlan &&
    (Boolean(raw?.start_agent_orchestration) ||
      usedTextTaskFallback ||
      explicitStartIntent ||
      explicitRequestedAgentCount > 1);

  const constraints = uniqueStrings([...ensureArray(raw?.constraints)]);
  const priority = normalizePriority(raw?.priority);
  let requiresClarification = Boolean(raw?.requires_clarification);
  let clarificationQuestion =
    typeof raw?.clarification_question === "string" && raw.clarification_question.trim()
      ? raw.clarification_question.trim()
      : null;
  if (startAgentOrchestration && hasRunnablePlan && explicitStartIntent) {
    requiresClarification = false;
    clarificationQuestion = null;
  }

  return {
    start_agent_orchestration: startAgentOrchestration,
    intent:
      typeof raw?.intent === "string" && raw.intent.trim()
        ? raw.intent.trim()
        : "start_local_bot_agents",
    task,
    objective:
      typeof raw?.objective === "string" && raw.objective.trim()
        ? raw.objective.trim()
        : task,
    agent_count: agentCount,
    agent_roles: roles,
    agent_assignments: assignments,
    priority,
    constraints,
    requires_clarification: requiresClarification,
    clarification_question: clarificationQuestion,
    reasoning_summary:
      typeof raw?.reasoning_summary === "string" && raw.reasoning_summary.trim()
        ? raw.reasoning_summary.trim()
        : "Prepared a local multi-bot orchestration plan.",
    approval_prompt:
      typeof raw?.approval_prompt === "string" && raw.approval_prompt.trim()
        ? raw.approval_prompt.trim()
        : "Reply YES to launch this plan locally, or tell me what to change.",
    handoff: {
      target: "local_voyager_orchestrator",
      mode: startAgentOrchestration ? "orchestrate" : "ignore",
      task,
      constraints,
      requested_agent_count: agentCount,
      agent_assignments: assignments,
      source: {
        platform: "iMessage",
        sender_id: context.senderId,
        space_id: context.spaceId,
      },
    },
  };
}

async function requestOrchestrationProposal({
  senderId,
  spaceId,
  conversation,
  currentDraft = null,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for LLM intent parsing.");
  }

  const userQuery = latestConversationText(conversation);
  const memoryContext = await sharedMemoryStore.retrieveRelevantMemories({
    query: userQuery,
    spaceId,
    senderId,
    limit: SUPABASE_MEMORY_SEARCH_LIMIT,
  });
  const memoryContextForPrompt = summarizeMemoryContextForProposal(memoryContext);

  const systemPrompt = [
    "You are the planning layer for a local Photon iMessage orchestrator.",
    "Your output drives local Voyager Minecraft bots, no VM and no remote handoff.",
    "Analyze the request and return launch-ready JSON only.",
    "Photon must ask explicit user approval before launch. Do not assume approval.",
    "Use short concrete assignments that map to runnable bot actions.",
    "Default to exactly 1 agent unless the user explicitly asks for multiple agents/bots.",
    `Only use these worker roles in agent_roles and agent_assignments.role: ${CANONICAL_WORKER_ROLES.join(", ")}.`,
    "If the user request does not need bots, set start_agent_orchestration=false and mode=ignore.",
    "If the user explicitly says to start/spawn agents and gives actionable work, set start_agent_orchestration=true and requires_clarification=false.",
    "When tasks are independent, leave depends_on empty so the orchestrator can run them in parallel.",
    "When sequencing is required, use depends_on with assignment ids.",
    "You are given memory_context from a Supabase Memory MCP retrieval layer.",
    "If memory_context resolves locations (example: home/base) to coordinates, include those coordinates in tasks.",
    "Prefer explicit coordinate instructions when available (x=..., y=..., z=...).",
    "JSON schema:",
    "{",
    '  "start_agent_orchestration": boolean,',
    '  "intent": string,',
    '  "task": string | null,',
    '  "objective": string | null,',
    '  "agent_count": number,',
    '  "agent_roles": string[],',
    '  "agent_assignments": [',
    "    {",
    '      "id": string,',
    '      "role": "miner" | "builder" | "forager",',
    '      "task": string,',
    '      "depends_on": string[],',
    '      "deliverable": string,',
    '      "success_signal": string,',
    '      "priority": "low" | "normal" | "high"',
    "    }",
    "  ],",
    '  "priority": "low" | "normal" | "high",',
    '  "constraints": string[],',
    '  "requires_clarification": boolean,',
    '  "clarification_question": string | null,',
    '  "reasoning_summary": string,',
    '  "approval_prompt": string,',
    '  "handoff": {',
    '    "target": "local_voyager_orchestrator",',
    '    "mode": "orchestrate" | "ignore",',
    '    "task": string | null,',
    '    "constraints": string[],',
    '    "requested_agent_count": number,',
    '    "agent_assignments": [',
    "      {",
    '        "id": string,',
    '        "role": string,',
    '        "task": string,',
    '        "depends_on": string[]',
    "      }",
    "    ]",
    "  }",
    "}",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            platform: "iMessage",
            sender_id: senderId,
            space_id: spaceId,
            conversation,
            current_draft: currentDraft,
            memory_context: memoryContextForPrompt,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response did not include message content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`OpenAI returned invalid JSON: ${content}`);
  }

  const normalizedProposal = normalizeProposal(parsed, { senderId, spaceId, conversation });
  return augmentProposalWithMemoryContext(normalizedProposal, memoryContext);
}

function serializeProposalState(state) {
  return {
    proposal_id: state.id,
    status: state.status,
    revision: state.revision,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    sender_id: state.senderId,
    space_id: state.spaceId,
    user_messages: state.userMessages,
    proposal: state.proposal,
    tracking_path: toRelativeTrackingPath(state.filePath),
  };
}

function persistProposalState(state) {
  writeJsonFile(state.filePath, serializeProposalState(state));
  updateTrackerIndex();
}

function serializeRun(run) {
  return {
    run_id: run.id,
    proposal_id: run.proposalId,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    sender_id: run.senderId,
    space_id: run.spaceId,
    task: run.task,
    intent: run.intent,
    priority: run.priority,
    constraints: run.constraints,
    agent_count: run.agentCount,
    agent_roles: run.agentRoles,
    agent_assignments: run.agentAssignments,
    latest_message: run.latestMessage,
    cancel_requested: run.cancelRequested,
    finalized: run.finalized,
    tracking_path: toRelativeTrackingPath(run.filePath),
    payload: run.payload,
    events: run.events,
  };
}

function persistRun(run) {
  run.updatedAt = nowIso();
  writeJsonFile(run.filePath, serializeRun(run));
  updateTrackerIndex();
}

function createProposalState({ senderId, spaceId, text, proposal }) {
  const proposalId = createId("proposal");
  const state = {
    id: proposalId,
    status: "pending",
    revision: 1,
    senderId,
    spaceId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    userMessages: [{ at: nowIso(), text }],
    proposal,
    filePath: path.join(PROPOSALS_DIR, `${proposalId}.json`),
  };

  pendingApprovals.set(spaceId, state);
  persistProposalState(state);
  return state;
}

function appendProposalFeedback(state, text) {
  state.userMessages.push({ at: nowIso(), text });
  state.updatedAt = nowIso();
}

function recordRunEvent(run, event) {
  const normalized = {
    at: nowIso(),
    ...event,
  };

  run.events.push(normalized);
  if (run.events.length > 500) {
    run.events = run.events.slice(-500);
  }

  run.latestMessage = normalized.message;
  run.updatedAt = normalized.at;
  persistRun(run);

  const memoryEntry = {
    run_id: run.id,
    proposal_id: run.proposalId,
    sender_id: run.senderId,
    space_id: run.spaceId,
    agent_id: normalized.agent || normalized.role || "foreman",
    role: normalized.role || null,
    event_type: normalized.type || "log",
    memory_type: "observation",
    message: normalized.message || "",
    content: normalized.message || `${normalized.type || "log"} event`,
    payload: normalized.data || {},
    metadata: normalized.data || {},
    created_at: normalized.at,
  };

  sharedMemoryStore.append(memoryEntry).catch((error) => {
    console.error(`⚠️ Supabase shared memory write failed: ${error.message}`);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large"));
        try { req.destroy(); } catch (error) {}
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, html) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function findLatestAgentPidFromEvents(run, agentId) {
  const events = Array.isArray(run?.events) ? run.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.agent !== agentId) continue;
    if (event?.type === "agent-process-started") {
      const pid = Number(event?.data?.pid);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  }
  return null;
}

function resolveAgentPid(run, agentId) {
  const child = run?.children?.[agentId];
  const activeChildPid = Number(child?.pid);
  if (Number.isInteger(activeChildPid) && activeChildPid > 0 && processExists(activeChildPid)) {
    return { pid: activeChildPid, source: "active-child" };
  }

  const eventPid = findLatestAgentPidFromEvents(run, agentId);
  if (Number.isInteger(eventPid) && eventPid > 0 && processExists(eventPid)) {
    return { pid: eventPid, source: "events" };
  }

  return { pid: null, source: null };
}

function buildRunAgentView(run) {
  const assignments = Array.isArray(run?.agentAssignments) ? run.agentAssignments : [];
  return assignments.map((assignment) => {
    const agentId = assignment.id;
    const resolved = resolveAgentPid(run, agentId);
    return {
      id: agentId,
      role: assignment.role,
      task: assignment.task,
      depends_on: assignment.depends_on || [],
      pid: resolved.pid,
      pid_source: resolved.source,
      is_alive: Number.isInteger(resolved.pid) ? processExists(resolved.pid) : false,
      is_active: Boolean(run?.children?.[agentId]),
    };
  });
}

function buildRunView(run, { includeEvents = false } = {}) {
  const agents = buildRunAgentView(run);
  const events = Array.isArray(run?.events) ? run.events : [];
  const limitedEvents = includeEvents ? events.slice(-DASHBOARD_EVENT_LIMIT) : events.slice(-25);
  return {
    id: run.id,
    proposal_id: run.proposalId,
    status: run.status,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    sender_id: run.senderId,
    space_id: run.spaceId,
    task: run.task,
    intent: run.intent,
    priority: run.priority,
    constraints: run.constraints || [],
    cancel_requested: Boolean(run.cancelRequested),
    finalized: Boolean(run.finalized),
    latest_message: run.latestMessage || null,
    tracking_path: toRelativeTrackingPath(run.filePath),
    tracking_absolute_path: run.filePath,
    agent_count: run.agentCount || agents.length,
    agent_roles: run.agentRoles || [],
    agents,
    event_count: events.length,
    events: limitedEvents,
  };
}

function buildSystemView() {
  const lockInfo = fs.existsSync(PROCESS_LOCK_PATH)
    ? (() => {
        try {
          return JSON.parse(fs.readFileSync(PROCESS_LOCK_PATH, "utf8"));
        } catch (error) {
          return { error: "Failed to parse lock file" };
        }
      })()
    : null;

  return {
    now: nowIso(),
    process: {
      pid: process.pid,
      node_version: process.version,
      uptime_sec: Math.round(process.uptime()),
    },
    voyager: {
      path: VOYAGER_PATH,
      python_bin: PYTHON_BIN,
      mc_host: MC_HOST,
      mc_port: MC_PORT,
      base_server_port: BASE_SERVER_PORT,
    },
    dashboard: {
      host: DASHBOARD_HOST,
      port: DASHBOARD_PORT,
      event_limit: DASHBOARD_EVENT_LIMIT,
      url: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/dashboard`,
    },
    tracking: {
      root: PHOTON_TRACKING_DIR,
      proposals_dir: PROPOSALS_DIR,
      runs_dir: RUNS_DIR,
      lock_file: PROCESS_LOCK_PATH,
      tracker_index: TRACKER_INDEX_PATH,
      lock_info: lockInfo,
    },
    counts: {
      total_runs: allRuns.size,
      active_runs: activeRuns.size,
      pending_approvals: pendingApprovals.size,
    },
  };
}

function collectLiveProcessViews() {
  const byPid = new Map();
  for (const run of allRuns.values()) {
    const agents = buildRunAgentView(run);
    for (const agent of agents) {
      if (!Number.isInteger(agent.pid) || agent.pid <= 0) continue;
      if (!agent.is_alive) continue;
      byPid.set(agent.pid, {
        pid: agent.pid,
        run_id: run.id,
        run_status: run.status,
        agent_id: agent.id,
        role: agent.role,
        task: agent.task,
        started_at: run.startedAt,
        updated_at: run.updatedAt,
      });
    }
  }

  return [...byPid.values()].sort((a, b) => (a.pid > b.pid ? 1 : -1));
}

function killPidWithEscalation(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: "Invalid PID" };
  }
  if (!processExists(pid)) {
    return { ok: false, message: `PID ${pid} is not running` };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { ok: false, message: `Failed to SIGTERM PID ${pid}: ${error.message}` };
  }

  const forceKill = () => {
    if (!processExists(pid)) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      console.error(`Failed to SIGKILL PID ${pid}: ${error.message}`);
    }
  };

  setTimeout(forceKill, 3500);
  return { ok: true, message: `Sent SIGTERM to PID ${pid}. Will SIGKILL after timeout if needed.` };
}

function requestRunCancellation(run, { source = "photon" } = {}) {
  run.cancelRequested = true;
  recordRunEvent(run, {
    type: "cancel-requested",
    message: `Cancellation requested from ${source}.`,
    data: { source },
  });

  const children = Object.values(run.children || {});
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch (error) {
      console.error(`Failed to SIGTERM child: ${error.message}`);
    }
  }

  setTimeout(() => {
    for (const child of Object.values(run.children || {})) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        console.error(`Failed to SIGKILL child: ${error.message}`);
      }
    }
  }, 5000);
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voyager Agent Dashboard</title>
  <style>
    :root {
      --bg: #0e1116;
      --panel: #171b22;
      --panel-2: #1f2530;
      --text: #e8edf5;
      --muted: #a2afc2;
      --ok: #1dbb77;
      --warn: #f0a44b;
      --err: #e35d5d;
      --accent: #58a6ff;
      --border: #2b3442;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "SF Mono", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      color: var(--text);
      background: radial-gradient(1200px 700px at 5% -10%, #1d2736 0%, var(--bg) 45%), var(--bg);
    }
    .wrap { max-width: 1400px; margin: 0 auto; padding: 16px; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    .muted { color: var(--muted); }
    .grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
    @media (min-width: 1100px) { .grid { grid-template-columns: 360px 1fr; } }
    .card {
      border: 1px solid var(--border);
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border-radius: 12px;
      padding: 12px;
      overflow: hidden;
    }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .grow { flex: 1; }
    .pill {
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--border);
      background: #10151d;
    }
    .status-running { border-color: #2e774f; color: #8de6b7; }
    .status-completed { border-color: #2e5f77; color: #9cd8ff; }
    .status-failed, .status-cancelled { border-color: #7b3b3b; color: #ffaaaa; }
    .btn {
      border: 1px solid #41506a;
      color: var(--text);
      background: #213047;
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { filter: brightness(1.1); }
    .btn.warn { background: #5b3a1f; border-color: #90603a; }
    .btn.danger { background: #5b2323; border-color: #924040; }
    .btn[disabled] { opacity: 0.45; cursor: not-allowed; }
    .small { font-size: 12px; }
    .list { display: flex; flex-direction: column; gap: 8px; max-height: 72vh; overflow: auto; }
    .run-item { border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: #11161f; cursor: pointer; }
    .run-item.active { border-color: var(--accent); box-shadow: 0 0 0 1px #2b67aa inset; }
    .mono { font-family: inherit; }
    .logs {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #0c1016;
      padding: 10px;
      max-height: 52vh;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.35;
    }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-bottom: 1px solid var(--border); padding: 7px 6px; text-align: left; vertical-align: top; }
    .ok { color: var(--ok); } .warnc { color: var(--warn); } .err { color: var(--err); }
    .divider { border-top: 1px solid var(--border); margin: 10px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="row">
      <h1 class="grow">Voyager Agent Dashboard</h1>
      <button id="refreshBtn" class="btn">Refresh</button>
      <button id="autorefreshBtn" class="btn">Auto: ON</button>
    </div>
    <div class="small muted" id="systemLine">Loading system info...</div>
    <div class="grid" style="margin-top: 12px;">
      <section class="card">
        <div class="row" style="margin-bottom: 8px;">
          <strong class="grow">Runs</strong>
          <span id="runCounts" class="small muted"></span>
        </div>
        <div id="runList" class="list"></div>
      </section>
      <section class="card">
        <div id="runDetail" class="small muted">Select a run to view details and full logs.</div>
      </section>
    </div>
  </div>
<script>
(() => {
  const state = {
    runs: [],
    selectedRunId: null,
    autoRefresh: true,
  };

  const els = {
    runList: document.getElementById("runList"),
    runDetail: document.getElementById("runDetail"),
    systemLine: document.getElementById("systemLine"),
    runCounts: document.getElementById("runCounts"),
    refreshBtn: document.getElementById("refreshBtn"),
    autorefreshBtn: document.getElementById("autorefreshBtn"),
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  function statusClass(status) {
    if (status === "running" || status === "starting") return "status-running";
    if (status === "completed") return "status-completed";
    if (status === "failed" || status === "cancelled") return "status-failed";
    return "";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function killRun(runId) {
    if (!confirm("Cancel run " + runId + "?")) return;
    try {
      await api("/api/runs/" + encodeURIComponent(runId) + "/cancel", { method: "POST" });
      await refresh();
    } catch (error) {
      alert("Cancel failed: " + error.message);
    }
  }

  async function killAgent(runId, agentId) {
    if (!confirm("Kill agent " + agentId + " in run " + runId + "?")) return;
    try {
      await api("/api/runs/" + encodeURIComponent(runId) + "/agents/" + encodeURIComponent(agentId) + "/kill", { method: "POST" });
      await refresh();
    } catch (error) {
      alert("Kill failed: " + error.message);
    }
  }

  async function killPid(pid) {
    if (!confirm("Kill PID " + pid + "?")) return;
    try {
      await api("/api/pids/" + encodeURIComponent(String(pid)) + "/kill", { method: "POST" });
      await refresh();
    } catch (error) {
      alert("Kill PID failed: " + error.message);
    }
  }

  function renderRunList() {
    const sorted = [...state.runs].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    els.runCounts.textContent = sorted.length + " total";
    if (sorted.length === 0) {
      els.runList.innerHTML = '<div class="small muted">No runs yet.</div>';
      return;
    }
    els.runList.innerHTML = sorted.map((run) => {
      const alive = (run.agents || []).filter((a) => a.is_alive).length;
      return '<div class="run-item ' + (run.id === state.selectedRunId ? "active" : "") + '" data-run-id="' + escapeHtml(run.id) + '">' +
        '<div class="row"><strong class="grow">' + escapeHtml(run.id) + '</strong><span class="pill ' + statusClass(run.status) + '">' + escapeHtml(run.status) + '</span></div>' +
        '<div class="small muted" style="margin-top:4px;">' + escapeHtml(run.task || "unspecified") + '</div>' +
        '<div class="row small muted" style="margin-top:6px;"><span>agents ' + escapeHtml(run.agent_count) + '</span><span>alive ' + escapeHtml(alive) + '</span></div>' +
      '</div>';
    }).join("");
    els.runList.querySelectorAll(".run-item").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedRunId = el.getAttribute("data-run-id");
        renderRunList();
        renderRunDetail();
      });
    });
  }

  function renderRunDetail() {
    if (!state.selectedRunId) {
      els.runDetail.innerHTML = '<div class="small muted">Select a run to view details and full logs.</div>';
      return;
    }

    const run = state.runs.find((r) => r.id === state.selectedRunId);
    if (!run) {
      els.runDetail.innerHTML = '<div class="small muted">Run not found.</div>';
      return;
    }

    const agents = run.agents || [];
    const events = run.events || [];

    const eventLines = events.map((e) => {
      const who = e.agent ? ('[' + e.agent + '] ') : '';
      return escapeHtml((e.at || "") + " " + who + (e.type || "event") + " - " + (e.message || ""));
    }).join("\\n");

    const processRows = agents.map((agent) => {
      const aliveClass = agent.is_alive ? "ok" : "muted";
      const killBtn = agent.pid ? '<button class="btn danger" data-kill-agent="' + escapeHtml(agent.id) + '">Kill Agent</button>' : '<button class="btn danger" disabled>Kill Agent</button>';
      const killPidBtn = agent.pid ? '<button class="btn warn" data-kill-pid="' + escapeHtml(String(agent.pid)) + '">Kill PID</button>' : '<button class="btn warn" disabled>Kill PID</button>';
      return '<tr>' +
        '<td>' + escapeHtml(agent.id) + '</td>' +
        '<td>' + escapeHtml(agent.role) + '</td>' +
        '<td class="mono">' + escapeHtml(agent.pid || "n/a") + '</td>' +
        '<td class="' + aliveClass + '">' + (agent.is_alive ? "alive" : "not running") + '</td>' +
        '<td>' + escapeHtml(agent.task || "") + '</td>' +
        '<td>' + killBtn + ' ' + killPidBtn + '</td>' +
      '</tr>';
    }).join("");

    els.runDetail.innerHTML =
      '<div class="row">' +
        '<strong class="grow">Run ' + escapeHtml(run.id) + '</strong>' +
        '<span class="pill ' + statusClass(run.status) + '">' + escapeHtml(run.status) + '</span>' +
        '<button class="btn warn" data-cancel-run="' + escapeHtml(run.id) + '">Cancel Run</button>' +
      '</div>' +
      '<div class="small muted" style="margin-top:6px;">' + escapeHtml(run.task || "unspecified") + '</div>' +
      '<div class="row small" style="margin-top:8px;">' +
        '<span class="pill">priority ' + escapeHtml(run.priority || "normal") + '</span>' +
        '<span class="pill">events ' + escapeHtml(String(run.event_count || 0)) + '</span>' +
        '<span class="pill">updated ' + escapeHtml(run.updated_at || "") + '</span>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<strong class="small">Agent Processes</strong>' +
      '<table style="margin-top:6px;"><thead><tr><th>Agent</th><th>Role</th><th>PID</th><th>State</th><th>Task</th><th>Actions</th></tr></thead><tbody>' + processRows + '</tbody></table>' +
      '<div class="divider"></div>' +
      '<strong class="small">Full Event Log</strong>' +
      '<div class="logs" style="margin-top:6px;">' + (eventLines || "No events yet.") + '</div>';

    const cancelBtn = els.runDetail.querySelector("[data-cancel-run]");
    if (cancelBtn) cancelBtn.addEventListener("click", () => killRun(run.id));
    els.runDetail.querySelectorAll("[data-kill-agent]").forEach((btn) => {
      btn.addEventListener("click", () => killAgent(run.id, btn.getAttribute("data-kill-agent")));
    });
    els.runDetail.querySelectorAll("[data-kill-pid]").forEach((btn) => {
      btn.addEventListener("click", () => killPid(Number(btn.getAttribute("data-kill-pid"))));
    });
  }

  async function refresh() {
    try {
      const [runsResp, systemResp] = await Promise.all([
        api("/api/runs?include_events=1"),
        api("/api/system"),
      ]);
      state.runs = runsResp.runs || [];
      if (!state.selectedRunId && state.runs.length > 0) {
        state.selectedRunId = state.runs[0].id;
      }
      const c = systemResp.counts || {};
      const d = systemResp.dashboard || {};
      els.systemLine.textContent =
        "orchestrator pid " + (systemResp.process?.pid || "n/a") +
        " | active runs " + (c.active_runs || 0) +
        " | pending drafts " + (c.pending_approvals || 0) +
        " | dashboard " + (d.host || "") + ":" + (d.port || "");
      renderRunList();
      renderRunDetail();
    } catch (error) {
      els.systemLine.textContent = "Dashboard refresh failed: " + error.message;
    }
  }

  els.refreshBtn.addEventListener("click", refresh);
  els.autorefreshBtn.addEventListener("click", () => {
    state.autoRefresh = !state.autoRefresh;
    els.autorefreshBtn.textContent = "Auto: " + (state.autoRefresh ? "ON" : "OFF");
  });

  setInterval(() => {
    if (state.autoRefresh) refresh();
  }, 2000);

  refresh();
})();
</script>
</body>
</html>`;
}

function startDashboardServer() {
  dashboardServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = reqUrl.pathname;
      const segments = splitPath(pathname);
      const method = req.method || "GET";

      if (method === "GET" && (pathname === "/" || pathname === "/dashboard")) {
        sendHtml(res, renderDashboardHtml());
        return;
      }

      if (method === "GET" && pathname === "/api/system") {
        sendJson(res, 200, buildSystemView());
        return;
      }

      if (method === "GET" && pathname === "/api/processes") {
        sendJson(res, 200, { processes: collectLiveProcessViews() });
        return;
      }

      if (method === "GET" && pathname === "/api/runs") {
        const includeEvents =
          reqUrl.searchParams.get("include_events") === "1" ||
          reqUrl.searchParams.get("includeEvents") === "1";
        const runs = [...allRuns.values()]
          .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
          .map((run) => buildRunView(run, { includeEvents }));
        sendJson(res, 200, { runs });
        return;
      }

      if (segments[0] === "api" && segments[1] === "runs" && segments[2]) {
        const runId = segments[2];
        const run = allRuns.get(runId);
        if (!run) {
          sendJson(res, 404, { error: `Run ${runId} not found` });
          return;
        }

        if (method === "GET" && segments.length === 3) {
          sendJson(res, 200, { run: buildRunView(run, { includeEvents: true }) });
          return;
        }

        if (method === "POST" && segments[3] === "cancel") {
          requestRunCancellation(run, { source: "dashboard" });
          sendJson(res, 200, {
            ok: true,
            run_id: run.id,
            status: run.status,
            message: `Cancellation requested for run ${run.id}`,
          });
          return;
        }

        if (method === "POST" && segments[3] === "agents" && segments[4] && segments[5] === "kill") {
          const agentId = segments[4];
          const resolved = resolveAgentPid(run, agentId);
          if (!resolved.pid) {
            sendJson(res, 404, { error: `No live process found for agent ${agentId} in run ${run.id}` });
            return;
          }
          const result = killPidWithEscalation(resolved.pid);
          recordRunEvent(run, {
            type: "agent-kill-requested",
            agent: agentId,
            message: `Dashboard kill requested for agent ${agentId} (pid ${resolved.pid}). ${result.message}`,
            data: { pid: resolved.pid, source: "dashboard", ok: result.ok },
          });
          sendJson(res, result.ok ? 200 : 500, {
            ok: result.ok,
            run_id: run.id,
            agent_id: agentId,
            pid: resolved.pid,
            message: result.message,
          });
          return;
        }
      }

      if (segments[0] === "api" && segments[1] === "pids" && segments[2] && method === "POST" && segments[3] === "kill") {
        const pid = Number(segments[2]);
        const known = collectLiveProcessViews().find((proc) => proc.pid === pid);
        if (!known) {
          sendJson(res, 404, { error: `PID ${pid} is not mapped to a live Voyager run in memory` });
          return;
        }
        const result = killPidWithEscalation(pid);
        const run = allRuns.get(known.run_id);
        if (run) {
          recordRunEvent(run, {
            type: "pid-kill-requested",
            agent: known.agent_id,
            role: known.role,
            message: `Dashboard requested PID kill for ${pid}. ${result.message}`,
            data: { pid, source: "dashboard", ok: result.ok },
          });
        }
        sendJson(res, result.ok ? 200 : 500, {
          ok: result.ok,
          pid,
          run_id: known.run_id,
          agent_id: known.agent_id,
          message: result.message,
        });
        return;
      }

      if (method === "POST" && pathname.startsWith("/api/")) {
        await readJsonBody(req).catch(() => ({}));
      }

      sendJson(res, 404, { error: `Not found: ${pathname}` });
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Internal server error" });
    }
  });

  dashboardServer.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    console.log(`🖥️  Voyager dashboard: http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/dashboard`);
  });
}

function formatAssignments(assignments) {
  if (!assignments.length) {
    return ["1) generalist: handle the full task"];
  }

  return assignments.map((assignment, index) => {
    return `${index + 1}) ${assignment.role}: ${truncate(assignment.task, 140)}`;
  });
}

function formatProposalMessage(state) {
  const proposal = state.proposal;
  const assignments = formatAssignments(proposal.agent_assignments);
  return [
    `Task: ${proposal.task || "unspecified"}`,
    `Agents: ${proposal.agent_count || 1}`,
    ...assignments,
    "Is this good? Reply YES or tell me what to change.",
  ].join("\n");
}

function formatRunStatus(run, { detailed = false } = {}) {
  const lines = [
    `Run ${run.id}`,
    `Status: ${run.status}`,
    `Task: ${run.task || "unspecified"}`,
    `Agents: ${run.agentCount || 1}`,
    `Roles: ${run.agentRoles.length > 0 ? run.agentRoles.join(", ") : "generalist"}`,
    `Tracking: ${toRelativeTrackingPath(run.filePath)}`,
  ];

  if (run.latestMessage) {
    lines.push(`Latest: ${truncate(run.latestMessage, 220)}`);
  }

  if (detailed) {
    const activeAgentIds = Object.keys(run.children || {});
    if (activeAgentIds.length > 0) {
      lines.push(`Active agents: ${activeAgentIds.join(", ")}`);
    }

    const recentEvents = run.events.slice(-8);
    if (recentEvents.length > 0) {
      lines.push("Recent events:");
      for (const event of recentEvents) {
        const agentPrefix = event.agent ? `[${event.agent}] ` : "";
        lines.push(`- ${agentPrefix}${truncate(event.message || "", 220)}`);
      }
    }
  }

  return lines.join("\n");
}

function formatSpaceStatus(spaceId, requestedRunId = null) {
  if (requestedRunId) {
    const run = allRuns.get(requestedRunId);
    if (!run || run.spaceId !== spaceId) {
      return `I couldn't find run ${requestedRunId} in this chat.`;
    }
    return formatRunStatus(run, { detailed: true });
  }

  const lines = [];
  const pending = pendingApprovals.get(spaceId);

  if (pending) {
    lines.push(
      `Pending draft: ${pending.proposal.task || "unspecified"} ` +
      `(rev ${pending.revision}, ${pending.proposal.agent_count || 1} agents)`
    );
    lines.push(`Draft tracking: ${toRelativeTrackingPath(pending.filePath)}`);
  } else {
    lines.push("Pending draft: none");
  }

  const runIds = [...getSpaceRunIds(spaceId)];
  const recentRuns = runIds
    .map((runId) => allRuns.get(runId))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .slice(0, 3);

  if (recentRuns.length === 0) {
    lines.push("Runs: none");
  } else {
    lines.push("Runs:");
    for (const run of recentRuns) {
      lines.push(
        `- ${run.id} — ${run.status} — ${truncate(run.task || "unspecified", 100)}`
      );
    }
  }

  lines.push(`Tracker index: ${toRelativeTrackingPath(TRACKER_INDEX_PATH)}`);
  return lines.join("\n");
}

function createRunFromProposal(state) {
  const runId = createId("run");
  const run = {
    id: runId,
    proposalId: state.id,
    status: "starting",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    senderId: state.senderId,
    spaceId: state.spaceId,
    task: state.proposal.task,
    intent: state.proposal.intent,
    priority: state.proposal.priority,
    constraints: state.proposal.constraints,
    agentCount: state.proposal.agent_count,
    agentRoles: state.proposal.agent_roles,
    agentAssignments: state.proposal.agent_assignments,
    latestMessage: null,
    cancelRequested: false,
    finalized: false,
    events: [],
    payload: null,
    children: {},
    filePath: path.join(RUNS_DIR, `${runId}.json`),
  };

  allRuns.set(runId, run);
  registerRunForSpace(state.spaceId, runId);
  recordRunEvent(run, {
    type: "plan-approved",
    message: "User approved the local orchestration plan.",
  });
  persistRun(run);
  return run;
}

function buildLaunchPayload(proposalState, run) {
  const approvedAt = nowIso();

  return {
    session_id: run.id,
    proposal_id: proposalState.id,
    approved_at: approvedAt,
    conversation: proposalState.userMessages,
    tracking: {
      index_path: TRACKER_INDEX_PATH,
      proposal_path: proposalState.filePath,
      run_path: run.filePath,
    },
    ...proposalState.proposal,
    handoff: {
      ...proposalState.proposal.handoff,
      session_id: run.id,
      proposal_id: proposalState.id,
      approved_at: approvedAt,
      tracking: {
        index_path: TRACKER_INDEX_PATH,
        proposal_path: proposalState.filePath,
        run_path: run.filePath,
      },
      conversation: proposalState.userMessages,
    },
  };
}

function buildAgentOverrideProposal({ role, task, senderId, spaceId, assignmentId = null }) {
  const normalizedTask = `${task || ""}`.trim();
  const forcedRole = canonicalizeWorkerRole(role, normalizedTask, role, 0);
  const normalizedAssignmentId =
    typeof assignmentId === "string" && assignmentId.trim()
      ? assignmentId.trim()
      : `${forcedRole}-1`;
  const assignment = normalizeAssignment(
    {
      id: normalizedAssignmentId,
      role: forcedRole,
      task: normalizedTask,
      deliverable: `Update for ${forcedRole}`,
      success_signal: `Task completed by ${forcedRole}`,
      priority: "normal",
    },
    0,
    {
      roles: [forcedRole],
      task: normalizedTask,
      priority: "normal",
    }
  );
  const constraints = [
    `agent override: force ${forcedRole}`,
    assignmentId ? `assignment override: ${normalizedAssignmentId}` : null,
  ].filter(Boolean);

  return {
    start_agent_orchestration: Boolean(normalizedTask),
    intent: "start_local_bot_agents",
    task: normalizedTask || null,
    objective: normalizedTask || null,
    agent_count: 1,
    agent_roles: [forcedRole],
    agent_assignments: [assignment],
    priority: "normal",
    constraints,
    requires_clarification: false,
    clarification_question: null,
    reasoning_summary: `Applied explicit agent override: ${forcedRole}.`,
    approval_prompt: "Reply YES to launch this override, or tell me what to change.",
    handoff: {
      target: "local_voyager_orchestrator",
      mode: normalizedTask ? "orchestrate" : "ignore",
      task: normalizedTask || null,
      constraints,
      requested_agent_count: 1,
      agent_assignments: [assignment],
      source: {
        platform: "iMessage",
        sender_id: senderId,
        space_id: spaceId,
      },
    },
  };
}

function collectAssignmentsForSpace({ pending, activeRun }) {
  return [
    ...ensureArray(pending?.proposal?.agent_assignments).map((assignment) => ({
      ...assignment,
      _source: "pending",
    })),
    ...ensureArray(activeRun?.agentAssignments).map((assignment) => ({
      ...assignment,
      _source: "active",
    })),
  ];
}

function resolveAssignmentOverride({ assignmentId, pending, activeRun }) {
  if (!assignmentId) return null;
  const normalized = assignmentId.trim().toLowerCase();
  if (!normalized) return null;

  return (
    collectAssignmentsForSpace({ pending, activeRun }).find(
      (assignment) => `${assignment?.id || ""}`.trim().toLowerCase() === normalized
    ) || null
  );
}

function buildBotUsername({ prefix, role, index, runId }) {
  const roleShort = role.slice(0, 3).toLowerCase();
  const runShort = runId.split("_")[1]?.slice(-3) || "run";
  const base = `${prefix}${roleShort}${index + 1}${runShort}`.replace(/[^a-zA-Z0-9_]/g, "");
  return base.slice(0, 16) || `bot${index + 1}`;
}

async function safeSend(space, text) {
  try {
    await space.send(text);
    rememberBotOutboundMessage({ spaceId: space.id, text });
  } catch (error) {
    console.error("❌ Failed to send iMessage reply:", error.message);
  }
}

function rememberBotOutboundMessage({ spaceId, text }) {
  const normalized = normalizeUserTextForSignature(text);
  if (!spaceId || !normalized) return;
  recentBotOutboundSignatures.set(`${spaceId}|${normalized}`, Date.now());
}

function isLikelyBotEcho({ spaceId, text, windowMs = 120000 }) {
  const normalized = normalizeUserTextForSignature(text);
  if (!spaceId || !normalized) return false;
  const signature = `${spaceId}|${normalized}`;
  const now = Date.now();
  const previous = recentBotOutboundSignatures.get(signature);

  for (const [key, ts] of recentBotOutboundSignatures.entries()) {
    if (now - ts > 10 * 60 * 1000) recentBotOutboundSignatures.delete(key);
  }

  return typeof previous === "number" && now - previous < windowMs;
}

function finalizeRun(run, { status, errorMessage = null } = {}) {
  if (run.finalized) return;

  run.finalized = true;
  run.endedAt = nowIso();

  if (run.cancelRequested) {
    run.status = "cancelled";
    recordRunEvent(run, {
      type: "cancelled",
      message: "Run was cancelled from Photon.",
    });
  } else if (errorMessage) {
    run.status = "failed";
    recordRunEvent(run, {
      type: "error",
      message: errorMessage,
    });
  } else {
    run.status = status || "completed";
    recordRunEvent(run, {
      type: run.status === "completed" ? "completed" : "state",
      message:
        run.status === "completed"
          ? "Local orchestration run completed successfully."
          : `Run finished with status ${run.status}.`,
    });
  }

  activeRuns.delete(run.id);
  persistRun(run);
}

function launchLocalRun(run, proposalState, space) {
  run.payload = buildLaunchPayload(proposalState, run);
  run.startedAt = nowIso();
  run.status = "running";

  recordRunEvent(run, {
    type: "launch",
    message: "Local orchestration launch requested.",
  });

  activeRuns.set(run.id, run);
  const orchestrator = new LocalOrchestrationAgent(run);

  (async () => {
    try {
      await orchestrator.runPlan(run.agentAssignments);
      finalizeRun(run, { status: "completed" });
    } catch (error) {
      if (run.cancelRequested) {
        finalizeRun(run, { status: "cancelled" });
      } else {
        finalizeRun(run, { status: "failed", errorMessage: error.message });
      }
    }

    const completionPrompt =
      run.status === "completed"
        ? "Done. Send the next task when ready."
        : null;

    await safeSend(
      space,
      [
        `Run ${run.id} ${run.status}.`,
        completionPrompt,
      ]
        .filter(Boolean)
        .join("\n")
    );
  })().catch((error) => {
    finalizeRun(run, { status: "failed", errorMessage: error.message });
  });
}

async function proposeNewPlan({ text, senderId, spaceId, space }) {
  const proposal = await requestOrchestrationProposal({
    senderId,
    spaceId,
    conversation: [{ at: nowIso(), text }],
  });

  console.log("   Parsed orchestration:");
  console.log(JSON.stringify(proposal, null, 2));

  if (!proposal.start_agent_orchestration) {
    await safeSend(space, MINECRAFT_AGENT_BOILERPLATE);
    return;
  }

  const state = createProposalState({ senderId, spaceId, text, proposal });
  await safeSend(space, formatProposalMessage(state));
}

async function revisePendingPlan({ state, text, senderId, spaceId, space }) {
  appendProposalFeedback(state, text);

  const revisedProposal = await requestOrchestrationProposal({
    senderId,
    spaceId,
    conversation: state.userMessages,
    currentDraft: state.proposal,
  });

  console.log("   Revised orchestration:");
  console.log(JSON.stringify(revisedProposal, null, 2));

  if (!revisedProposal.start_agent_orchestration) {
    state.status = "cancelled";
    persistProposalState(state);
    pendingApprovals.delete(spaceId);
    await safeSend(space, "No launch queued. Send a task when ready.");
    return;
  }

  state.revision += 1;
  state.updatedAt = nowIso();
  state.proposal = revisedProposal;
  persistProposalState(state);
  await safeSend(space, formatProposalMessage(state));
}

function discardPendingPlan(state, spaceId, { status = "cancelled" } = {}) {
  if (!state) return;
  state.status = status;
  state.updatedAt = nowIso();
  persistProposalState(state);
  pendingApprovals.delete(spaceId);
}

async function proposeAgentOverridePlan({
  text,
  role,
  assignmentId = null,
  task,
  senderId,
  spaceId,
  space,
  preface = "",
}) {
  const baseProposal = buildAgentOverrideProposal({
    role,
    task,
    senderId,
    spaceId,
    assignmentId,
  });
  const memoryContext = await sharedMemoryStore.retrieveRelevantMemories({
    query: task,
    spaceId,
    senderId,
    limit: SUPABASE_MEMORY_SEARCH_LIMIT,
  });
  const proposal = augmentProposalWithMemoryContext(baseProposal, memoryContext);
  if (!proposal.start_agent_orchestration) {
    await safeSend(
      space,
      "I need a task for the override. Use `/override <role|assignment_id> <task>`."
    );
    return;
  }

  const state = createProposalState({ senderId, spaceId, text, proposal });
  await safeSend(space, [preface, formatProposalMessage(state)].filter(Boolean).join("\n"));
}

async function handleAgentOverrideRequest({ text, senderId, spaceId, space }) {
  const override = parseAgentOverrideRequest(text);
  if (!override) return false;

  const pending = pendingApprovals.get(spaceId);
  const activeRun = getLatestActiveRunForSpace(spaceId);
  const allKnownAssignments = collectAssignmentsForSpace({ pending, activeRun });

  let requestedRole = null;
  let requestedAssignmentId = null;
  let task = "";
  let overrideLabel = "";

  if (override.mode === "role") {
    requestedRole = override.role;
    if (!requestedRole || !CANONICAL_WORKER_ROLES.includes(requestedRole)) {
      await safeSend(space, "Use `/override <miner|builder|forager|assignment_id> <task>`.");
      return true;
    }
    task = override.task || pending?.proposal?.task || activeRun?.task || "";
    overrideLabel = `role ${requestedRole}`;
  } else if (override.mode === "assignment") {
    const assignment = resolveAssignmentOverride({
      assignmentId: override.assignmentId,
      pending,
      activeRun,
    });
    if (!assignment) {
      const ids = uniqueStrings(allKnownAssignments.map((item) => item.id));
      await safeSend(
        space,
        ids.length > 0
          ? [
              `I couldn't find assignment \`${override.assignmentId}\` in the current draft/run.`,
              `Known assignments: ${ids.join(", ")}`,
              "Try `/override <assignment_id> [task]`.",
            ].join("\n")
          : "I couldn't find any assignment ids in the current draft/run. Use `/override <role> <task>`."
      );
      return true;
    }

    requestedRole = canonicalizeWorkerRole(
      assignment.role,
      assignment.task || override.task || "",
      "builder",
      0
    );
    requestedAssignmentId = assignment.id;
    task = override.task || assignment.task || pending?.proposal?.task || activeRun?.task || "";
    overrideLabel = `assignment ${assignment.id} (${requestedRole})`;
  } else {
    await safeSend(space, "Use `/override <role|assignment_id> <task>`.");
    return true;
  }

  if (!task) {
    await safeSend(
      space,
      "No task found to override yet. Use `/override <role|assignment_id> <task>`."
    );
    return true;
  }

  const prefaceLines = [`Applying agent override: ${overrideLabel}.`];
  if (pending) {
    discardPendingPlan(pending, spaceId, { status: "cancelled" });
    prefaceLines.push(`Cancelled pending draft ${pending.id}.`);
  }
  if (activeRun) {
    requestRunCancellation(activeRun, { source: "photon-override" });
    prefaceLines.push(`Requested cancellation for active run ${activeRun.id}.`);
  }

  await proposeAgentOverridePlan({
    text,
    role: requestedRole,
    assignmentId: requestedAssignmentId,
    task,
    senderId,
    spaceId,
    space,
    preface: prefaceLines.join("\n"),
  });
  return true;
}

async function handleEndSessionRequest({ spaceId, space, source = "photon-end" }) {
  const pending = pendingApprovals.get(spaceId);
  const activeRun = getLatestActiveRunForSpace(spaceId);
  const lines = [];

  if (pending) {
    discardPendingPlan(pending, spaceId, { status: "cancelled" });
    lines.push(`Cancelled pending draft ${pending.id}.`);
  }
  if (activeRun) {
    requestRunCancellation(activeRun, { source });
    lines.push(`Requested cancellation for run ${activeRun.id}.`);
  }

  lines.push("Session ended for now. Send your next task any time (or `/new <task>`).");
  await safeSend(space, lines.join("\n"));
}

async function approvePendingPlan({ state, space, spaceId }) {
  state.status = "approved";
  state.updatedAt = nowIso();
  persistProposalState(state);
  pendingApprovals.delete(spaceId);

  const run = createRunFromProposal(state);
  launchLocalRun(run, state, space);

  await safeSend(
    space,
    [
      `Launching run ${run.id}.`,
      "Use /status if you want progress.",
    ].join("\n")
  );
}

async function cancelPendingPlan({ state, space, spaceId }) {
  discardPendingPlan(state, spaceId, { status: "cancelled" });
  await safeSend(space, "Cancelled the draft.");
}

async function cancelRun({ run, space }) {
  if (!run) {
    await safeSend(space, "I couldn't find that run.");
    return;
  }

  if (!activeRuns.has(run.id)) {
    await safeSend(space, `Run ${run.id} is not active.`);
    return;
  }

  requestRunCancellation(run, { source: "photon" });

  await safeSend(space, `Cancelling run ${run.id}.`);
}

function formatMemoryEntryLine(memory, index = 0) {
  const prefix = `${index + 1}. `;
  const text = summarizeMemoryText(memory?.text || "", 120) || "(empty memory)";
  const coordText = memory?.coordinates ? ` (${formatCoordinates(memory.coordinates)})` : "";
  const createdText = memory?.created_at ? ` [${memory.created_at}]` : "";
  return `${prefix}${text}${coordText}${createdText}`;
}

function formatMemorySearchResponse({ query, memoryContext }) {
  const lines = [
    `Memory lookup: "${query}"`,
  ];

  const resolved = ensureArray(memoryContext?.resolved_locations);
  if (resolved.length > 0) {
    lines.push("Resolved locations:");
    for (const location of resolved.slice(0, 5)) {
      const coordText = formatCoordinates(location.coordinates);
      lines.push(
        `- ${location.mention}${coordText ? ` -> ${coordText}` : ""}${
          location.text ? ` (${summarizeMemoryText(location.text, 90)})` : ""
        }`
      );
    }
  }

  const memories = ensureArray(memoryContext?.memories);
  if (memories.length > 0) {
    lines.push("Top memories:");
    for (let i = 0; i < Math.min(memories.length, 5); i += 1) {
      lines.push(`- ${formatMemoryEntryLine(memories[i], i)}`);
    }
  } else {
    lines.push("No memory rows matched this query.");
  }

  return lines.join("\n");
}

async function handleMemoryInstruction({
  text,
  space,
  spaceId,
  senderId,
  activeRun = null,
  allowNatural = false,
}) {
  const slashCommand = parseSlashMemoryCommand(text);
  const naturalCommand = allowNatural ? parseNaturalMemoryLogCommand(text) : null;
  const command = slashCommand || naturalCommand;
  if (!command) return false;

  if (!sharedMemoryStore.enabled) {
    await safeSend(
      space,
      "Supabase memory is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first."
    );
    return true;
  }

  if (command.action === "help") {
    await safeSend(
      space,
      [
        "Memory commands:",
        "/memory log <TEXT> — save explicit memory to Supabase",
        "/memory find <QUERY> — semantic lookup (includes coordinate recall)",
        "/memory recent — list recent memories for this chat",
        "Natural form also works: `log <text> in db`",
      ].join("\n")
    );
    return true;
  }

  if (command.action === "log") {
    const memoryText = toTrimmedString(command.text);
    if (!memoryText) {
      await safeSend(space, "Add memory text, for example: `/memory log home chest at x=12, y=64, z=-3`.");
      return true;
    }

    const logged = await sharedMemoryStore.logExplicitMemory({
      text: memoryText,
      senderId,
      spaceId,
      runId: activeRun?.id || null,
      agentId: activeRun ? "foreman" : "foreman",
      role: "foreman",
      source: slashCommand ? "slash-memory-log" : "natural-memory-log",
    });

    if (activeRun) {
      recordRunEvent(activeRun, {
        type: "memory-log",
        message: `Explicit memory logged to Supabase: ${summarizeMemoryText(memoryText, 140)}`,
        data: {
          sender_id: senderId,
          coordinates: logged.coordinates || null,
          aliases: logged.aliases || [],
        },
      });
    }

    const coordText = logged.coordinates ? `\nCoordinates: ${formatCoordinates(logged.coordinates)}` : "";
    const aliasText =
      logged.aliases && logged.aliases.length > 0
        ? `\nAliases: ${logged.aliases.join(", ")}`
        : "";
    await safeSend(
      space,
      `Saved memory to Supabase.${coordText}${aliasText}`
    );
    return true;
  }

  if (command.action === "search") {
    const query = toTrimmedString(command.query);
    if (!query) {
      await safeSend(space, "Add a query, for example: `/memory find home chest`.");
      return true;
    }

    const memoryContext = await sharedMemoryStore.retrieveRelevantMemories({
      query,
      spaceId,
      senderId,
      limit: SUPABASE_MEMORY_SEARCH_LIMIT,
    });
    await safeSend(space, formatMemorySearchResponse({ query, memoryContext }));
    return true;
  }

  if (command.action === "recent") {
    const recent = await sharedMemoryStore.listRecentMemories({
      spaceId,
      senderId,
      limit: 6,
    });
    if (!recent.length) {
      await safeSend(space, "No recent memory rows found for this chat.");
      return true;
    }

    await safeSend(
      space,
      [
        "Recent memories:",
        ...recent.map((memory, index) => `- ${formatMemoryEntryLine(memory, index)}`),
      ].join("\n")
    );
    return true;
  }

  return false;
}

async function handleCommand({ text, space, spaceId, senderId }) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const lower = command.toLowerCase();
  const targetId = rest[0];

  if (lower === "/help") {
    await safeSend(space, HELP_TEXT);
    return true;
  }

  if (lower === "/memory") {
    await handleMemoryInstruction({
      text,
      space,
      spaceId,
      senderId,
      activeRun: getLatestActiveRunForSpace(spaceId),
      allowNatural: false,
    });
    return true;
  }

  if (lower === "/status") {
    await safeSend(space, formatSpaceStatus(spaceId, targetId || null));
    return true;
  }

  if (lower === "/approve") {
    const state = pendingApprovals.get(spaceId);
    if (!state) {
      await safeSend(space, "There isn't a pending draft to approve right now.");
      return true;
    }
    await approvePendingPlan({ state, space, spaceId });
    return true;
  }

  if (lower === "/override") {
    await handleAgentOverrideRequest({ text, senderId, spaceId, space });
    return true;
  }

  if (lower === "/cancel") {
    if (targetId) {
      const run = allRuns.get(targetId);
      if (run && run.spaceId !== spaceId) {
        await safeSend(space, "I couldn't find that run in this chat.");
        return true;
      }
      await cancelRun({ run, space });
      return true;
    }

    const state = pendingApprovals.get(spaceId);
    if (!state) {
      await safeSend(space, "There isn't a pending draft to cancel right now.");
      return true;
    }

    await cancelPendingPlan({ state, space, spaceId });
    return true;
  }

  if (lower === "/end") {
    await handleEndSessionRequest({ spaceId, space, source: "photon-end" });
    return true;
  }

  if (lower === "/new") {
    const task = rest.join(" ").trim();
    const activeRun = getLatestActiveRunForSpace(spaceId);
    if (activeRun) {
      await cancelRun({ run: activeRun, space });
    }
    const pending = pendingApprovals.get(spaceId);
    if (pending) {
      await cancelPendingPlan({ state: pending, space, spaceId });
    }
    if (!task) {
      await safeSend(space, "Send `/new <task>` to launch a replacement agent task.");
      return true;
    }
    await proposeNewPlan({ text: task, senderId, spaceId, space });
    return true;
  }

  return false;
}

async function main() {
  ensureTrackingDirectories();
  acquireProcessLock();
  startDashboardServer();

  if (!isVoyagerRepoRoot(VOYAGER_PATH)) {
    throw new Error(
      `VOYAGER_PATH is invalid: ${VOYAGER_PATH}. Set VOYAGER_PATH to the repository root containing voyager/__init__.py.`
    );
  }

  console.log("🚀 Starting Photon local iMessage orchestrator...");

  const photon = getPhotonCredentials();
  const app = await Spectrum(
    photon.enabled
      ? {
          projectId: photon.projectId,
          projectSecret: photon.projectSecret,
          providers: [imessage.config()],
        }
      : {
          providers: [imessage.config({ local: true })],
        }
  );

  console.log(
    photon.enabled
      ? "✅ Connected with Photon cloud! Listening for messages...\n"
      : "✅ Connected in local iMessage mode! Listening for messages...\n"
  );
  console.log(`🤖 OpenAI planning model: ${OPENAI_MODEL}`);
  console.log(`🧩 OpenAI embedding model: ${OPENAI_EMBEDDING_MODEL}`);
  console.log(`🧠 Local orchestrator target: ${VOYAGER_PATH}`);
  console.log(`🐍 Python binary: ${PYTHON_BIN}`);
  console.log(`🎮 Minecraft target: ${MC_HOST}:${MC_PORT} (base bot server port ${BASE_SERVER_PORT})`);
  console.log(
    `🛠️  Multi-agent startup: stagger=${AGENT_START_STAGGER_MS}ms, skip_decompose_multi=${VOYAGER_SKIP_DECOMPOSE_FOR_MULTI_AGENT}, decompose_timeout=${VOYAGER_DECOMPOSE_TIMEOUT_SEC}s, env_request_timeout=${VOYAGER_ENV_REQUEST_TIMEOUT}s, reset_env_between_subgoals=${VOYAGER_RESET_ENV_BETWEEN_SUBGOALS}`
  );
  const memoryStatusLabel = sharedMemoryStore.enabled
    ? "enabled"
    : sharedMemoryStore.disabledByFlag
      ? "disabled (VOYAGER_MEMORY_MCP_ENABLED=0)"
      : "disabled";
  console.log(`💾 Supabase shared memory: ${memoryStatusLabel}`);
  if (sharedMemoryStore.enabled) {
    console.log(`   table: ${SUPABASE_SHARED_MEMORY_TABLE}`);
    if (sharedMemoryStore.projectId) {
      console.log(`   project context: ${sharedMemoryStore.projectId}`);
    }
  }
  console.log(`🗂️  Photon tracking directory: ${PHOTON_TRACKING_DIR}\n`);

  const seenMessages = new Set();
  const myNumber = process.env.IMESSAGE_BOT_ID || "";

  for await (const [space, message] of app.messages) {
    if (seenMessages.has(message.id)) continue;
    seenMessages.add(message.id);

    if (message.sender.id === myNumber || message.sender.id === "") {
      continue;
    }

    console.log(`📨 [${message.platform}] From: ${message.sender.id}`);

    try {
      switch (message.content.type) {
        case "text": {
          const text = message.content.text.trim();
          if (!text) break;

          console.log(`   Text: "${text}"`);

          const spaceId = space.id;
          const senderId = message.sender.id;

          if (isDuplicateRecentMessage({ senderId, spaceId, text })) {
            console.log("   Ignoring duplicate text event.");
            break;
          }
          if (isLikelyBotEcho({ spaceId, text })) {
            console.log("   Ignoring echoed bot message.");
            break;
          }

          if (await handleCommand({ text, space, spaceId, senderId })) {
            break;
          }

          if (
            await handleMemoryInstruction({
              text,
              space,
              spaceId,
              senderId,
              activeRun: getLatestActiveRunForSpace(spaceId),
              allowNatural: true,
            })
          ) {
            break;
          }

          if (await handleAgentOverrideRequest({ text, senderId, spaceId, space })) {
            break;
          }

          if (isEndSessionText(text)) {
            await handleEndSessionRequest({ spaceId, space, source: "photon-end-natural" });
            break;
          }

          const pending = pendingApprovals.get(spaceId);
          if (pending) {
            if (isAffirmative(text) || isAffirmativeReactionText(text)) {
              await approvePendingPlan({ state: pending, space, spaceId });
            } else if (isNegativeOnly(text)) {
              await safeSend(space, "Tell me what to change.");
            } else {
              await revisePendingPlan({
                state: pending,
                text,
                senderId,
                spaceId,
                space,
              });
            }
            break;
          }

          const activeRun = getLatestActiveRunForSpace(spaceId);
          if (activeRun) {
            if (isNewAgentRequestText(text)) {
              const nextTask = extractTaskFromNewAgentText(text);
              await cancelRun({ run: activeRun, space });
              if (!nextTask) {
                await safeSend(
                  space,
                  "Cancelled. Send `/new <task>` to start the replacement."
                );
              } else {
                await proposeNewPlan({ text: nextTask, senderId, spaceId, space });
              }
            } else {
              recordRunEvent(activeRun, {
                type: "user-note",
                message: `User note for active agent: ${text}`,
                data: { sender_id: senderId },
              });
              await safeSend(
                space,
                "An agent is already active. Send `/new <task>` to replace it."
              );
            }
            break;
          }

          await proposeNewPlan({ text, senderId, spaceId, space });
          break;
        }

        case "attachment": {
          const bytes = await message.content.read();
          console.log(`   Attachment: ${message.content.name} (${bytes.length} bytes)`);
          await safeSend(
            space,
            `Received your file: ${message.content.name}\nSend a task when you're ready and I'll propose a local orchestration plan.`
          );
          break;
        }

        case "custom": {
          console.log("   Custom:", message.content.raw);
          const spaceId = space.id;
          const pending = pendingApprovals.get(spaceId);
          if (pending) {
            const reactionApproval = extractAffirmativeReactionApproval(message);
            if (reactionApproval) {
              console.log(
                `   Reaction approval detected (${reactionApproval.kind} via ${reactionApproval.source}).`
              );
              await approvePendingPlan({ state: pending, space, spaceId });
            }
          }
          break;
        }

        default:
          console.log(`   Unknown content type: ${message.content.type}`);
      }
    } catch (error) {
      console.error("❌ Error:", error);
      await safeSend(
        space,
        `I hit an error while processing that message: ${error.message}`
      );
    }

    console.log("");
  }
}

process.on("SIGINT", () => {
  console.log("\n👋 Shutting down...");
  for (const run of activeRuns.values()) {
    run.cancelRequested = true;
    for (const child of Object.values(run.children || {})) {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        console.error(`Failed to stop child process: ${error.message}`);
      }
    }
  }
  if (dashboardServer) {
    try {
      dashboardServer.close();
    } catch (error) {
      console.error(`Failed to close dashboard server: ${error.message}`);
    }
  }
  releaseProcessLock();
  process.exit(0);
});

process.on("exit", () => {
  if (dashboardServer) {
    try {
      dashboardServer.close();
    } catch (error) {}
  }
  releaseProcessLock();
});

if (process.env.PHOTON_NO_MAIN !== "1") {
  main().catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
}

export {
  SupabaseSharedMemoryStore,
  sharedMemoryStore,
  parseCoordinateTripletFromText,
  extractLocationMentions,
  applyMemoryContextToTask,
  summarizeMemoryContextForProposal,
  augmentProposalWithMemoryContext,
  parseExplicitAgentCountFromText,
  extractAgentTasksFromText,
  isLikelyAgentStartRequestText,
  normalizeProposal,
  isAffirmativeReactionText,
  extractAffirmativeReactionApproval,
  parseSlashMemoryCommand,
  parseNaturalMemoryLogCommand,
};
