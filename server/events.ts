/**
 * Agent Event Store -- durable JSONL event history.
 *
 * Persists all ingested events to server/data/agent-events.jsonl
 * and keeps a rolling in-memory buffer for fast recent reads.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentEventInput {
  ts?: string;
  clientTs?: number;
  source?: "client" | "server";
  kind?: string;
  message?: string;
  agentName?: string | null;
  dedupeKey?: string | null;
  meta?: Record<string, unknown>;
}

export interface AgentEventRecord {
  id: string;
  ts: string;
  receivedAt: string;
  source: "client" | "server";
  kind: string;
  message: string;
  agentName: string | null;
  dedupeKey: string | null;
  clientTs: number | null;
  meta?: Record<string, unknown>;
}

interface EventQueryOptions {
  limit?: number;
  agentName?: string;
  kinds?: string[];
  sinceTs?: number;
  untilTs?: number;
}

interface EventSearchOptions extends EventQueryOptions {
  query: string;
  semantic?: boolean;
}

const EVENTS_DIR = join(import.meta.dir, "data");
export const EVENTS_LOG_FILE = join(EVENTS_DIR, "agent-events.jsonl");
const MAX_EVENT_MEMORY = 6000;

const eventBuffer: AgentEventRecord[] = [];
const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "with",
]);
const SEARCH_SYNONYMS: Record<string, string[]> = {
  trace: ["run", "tool", "call", "span", "execution"],
  run: ["trace", "execute", "tool", "invocation"],
  tool: ["trace", "run", "call"],
  error: ["failed", "failure", "unreachable", "exception"],
  fail: ["error", "failure", "unreachable"],
  chat: ["reply", "message", "assistant"],
  reply: ["chat", "response"],
  model: ["llm", "mistral", "override"],
  state: ["status", "health", "working"],
  social: ["chatting", "pairing", "interaction"],
};

if (!existsSync(EVENTS_DIR)) mkdirSync(EVENTS_DIR, { recursive: true });
if (!existsSync(EVENTS_LOG_FILE)) appendFileSync(EVENTS_LOG_FILE, "", "utf8");

function makeEventId(tsIso: string): string {
  return `${new Date(tsIso).getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function optionalString(value: unknown, maxChars = 120): string | null {
  if (typeof value !== "string") return null;
  const next = clampText(value, maxChars);
  return next || null;
}

function normalizeKind(value: unknown): string {
  if (typeof value !== "string") return "info";
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return cleaned || "info";
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toClientTs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function toTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pushToBuffer(record: AgentEventRecord): void {
  eventBuffer.push(record);
  if (eventBuffer.length > MAX_EVENT_MEMORY) {
    eventBuffer.splice(0, eventBuffer.length - MAX_EVENT_MEMORY);
  }
}

function parseEventRecord(line: string): AgentEventRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<AgentEventRecord>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.message !== "string" || typeof parsed.ts !== "string") return null;
    const ts = toIsoTimestamp(parsed.ts) ?? new Date().toISOString();
    const receivedAt = toIsoTimestamp(parsed.receivedAt) ?? ts;
    const source = parsed.source === "server" ? "server" : "client";
    const record: AgentEventRecord = {
      id: typeof parsed.id === "string" && parsed.id ? parsed.id : makeEventId(ts),
      ts,
      receivedAt,
      source,
      kind: normalizeKind(parsed.kind),
      message: clampText(parsed.message, 600),
      agentName: optionalString(parsed.agentName, 64),
      dedupeKey: optionalString(parsed.dedupeKey, 128),
      clientTs: toClientTs(parsed.clientTs),
    };
    if (parsed.meta && typeof parsed.meta === "object" && !Array.isArray(parsed.meta)) {
      record.meta = parsed.meta as Record<string, unknown>;
    }
    if (!record.message) return null;
    return record;
  } catch {
    return null;
  }
}

function loadEventBufferFromDisk(): void {
  try {
    const content = readFileSync(EVENTS_LOG_FILE, "utf8");
    if (!content.trim()) return;
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const record = parseEventRecord(trimmed);
      if (record) pushToBuffer(record);
    }
  } catch {
    // Best-effort load only; continue with empty memory buffer if malformed.
  }
}

loadEventBufferFromDisk();

export function appendAgentEvents(
  incoming: AgentEventInput[],
  fallbackSource: "client" | "server" = "client",
): AgentEventRecord[] {
  const nowIso = new Date().toISOString();
  const prepared: AgentEventRecord[] = [];

  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const message = clampText(typeof raw.message === "string" ? raw.message : "", 600);
    if (!message) continue;

    const source = raw.source === "server" ? "server" : fallbackSource;
    const ts = toIsoTimestamp(raw.ts)
      ?? (typeof raw.clientTs === "number" && Number.isFinite(raw.clientTs)
        ? new Date(raw.clientTs).toISOString()
        : nowIso);

    const record: AgentEventRecord = {
      id: makeEventId(ts),
      ts,
      receivedAt: nowIso,
      source,
      kind: normalizeKind(raw.kind),
      message,
      agentName: optionalString(raw.agentName, 64),
      dedupeKey: optionalString(raw.dedupeKey, 128),
      clientTs: toClientTs(raw.clientTs),
    };

    if (raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)) {
      record.meta = raw.meta;
    }

    prepared.push(record);
  }

  if (!prepared.length) return [];

  const lines = prepared.map((record) => JSON.stringify(record)).join("\n") + "\n";
  appendFileSync(EVENTS_LOG_FILE, lines, "utf8");

  for (const record of prepared) {
    pushToBuffer(record);
  }

  return prepared;
}

function eventMetaText(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  try {
    return JSON.stringify(meta);
  } catch {
    return "";
  }
}

function eventSearchText(row: AgentEventRecord): string {
  return [
    row.message,
    row.kind,
    row.agentName ?? "",
    row.dedupeKey ?? "",
    eventMetaText(row.meta),
  ].join(" ").toLowerCase();
}

function tokenizeSearch(text: string): string[] {
  const parts = text.toLowerCase().match(/[a-z0-9_:-]+/g) ?? [];
  return parts.filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));
}

function expandQueryTokens(tokens: string[]): string[] {
  const expanded = new Set<string>(tokens);
  for (const token of tokens) {
    const synonyms = SEARCH_SYNONYMS[token];
    if (!synonyms) continue;
    for (const synonym of synonyms) {
      const cleaned = synonym.trim().toLowerCase();
      if (cleaned) expanded.add(cleaned);
    }
  }
  return Array.from(expanded);
}

function applyEventFilters(rows: AgentEventRecord[], options: EventQueryOptions): AgentEventRecord[] {
  const agentFilter = options.agentName?.trim().toLowerCase();
  const kindsFilter = options.kinds && options.kinds.length > 0
    ? new Set(options.kinds.map((kind) => normalizeKind(kind)))
    : null;
  const sinceTs = toTimestamp(options.sinceTs);
  const untilTs = toTimestamp(options.untilTs);

  return rows.filter((row) => {
    if (agentFilter && (row.agentName ?? "").toLowerCase() !== agentFilter) return false;
    if (kindsFilter && !kindsFilter.has(row.kind)) return false;

    if (sinceTs !== null || untilTs !== null) {
      const rowTs = Date.parse(row.ts);
      if (!Number.isFinite(rowTs)) return false;
      if (sinceTs !== null && rowTs < sinceTs) return false;
      if (untilTs !== null && rowTs > untilTs) return false;
    }

    return true;
  });
}

function semanticScore(
  row: AgentEventRecord,
  queryText: string,
  queryTokens: string[],
  expandedQueryTokens: string[],
  nowTs: number,
): number {
  const text = eventSearchText(row);
  if (!text) return 0;

  let score = 0;

  if (text.includes(queryText)) {
    score += 3.4;
  }

  const textTokens = new Set(tokenizeSearch(text));
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      score += 1.55;
      continue;
    }
    // Fuzzy-ish fallback for prefix matches (semantic-ish for short forms).
    for (const textToken of textTokens) {
      if (textToken.startsWith(token) || token.startsWith(textToken)) {
        score += 0.5;
        break;
      }
    }
  }

  for (const token of expandedQueryTokens) {
    if (textTokens.has(token)) score += 0.4;
  }

  if (queryTokens.length > 1) {
    let inOrder = 0;
    let fromIndex = 0;
    for (const token of queryTokens) {
      const idx = text.indexOf(token, fromIndex);
      if (idx >= 0) {
        inOrder += 1;
        fromIndex = idx + token.length;
      }
    }
    score += (inOrder / queryTokens.length) * 1.05;
  }

  const eventTs = Date.parse(row.ts);
  if (Number.isFinite(eventTs)) {
    const ageHours = Math.max(0, (nowTs - eventTs) / 3_600_000);
    score += Math.max(0, 1 - ageHours / 72) * 0.8;
  }

  return score;
}

export function getRecentAgentEvents(options: EventQueryOptions = {}): AgentEventRecord[] {
  const limit = Math.min(5000, Math.max(1, options.limit ?? 200));
  const rows = applyEventFilters(eventBuffer, options);

  return rows.slice(Math.max(0, rows.length - limit)).reverse();
}

export function searchAgentEvents(options: EventSearchOptions): AgentEventRecord[] {
  const rawQuery = clampText(typeof options.query === "string" ? options.query : "", 240).toLowerCase();
  if (!rawQuery) return [];

  const limit = Math.min(5000, Math.max(1, options.limit ?? 200));
  const semantic = options.semantic !== false;
  const rows = applyEventFilters(eventBuffer, options);

  if (!rows.length) return [];

  if (!semantic) {
    const exactMatches = rows.filter((row) => eventSearchText(row).includes(rawQuery));
    return exactMatches
      .slice(Math.max(0, exactMatches.length - limit))
      .reverse();
  }

  const queryTokens = tokenizeSearch(rawQuery);
  if (!queryTokens.length) {
    const exactMatches = rows.filter((row) => eventSearchText(row).includes(rawQuery));
    return exactMatches
      .slice(Math.max(0, exactMatches.length - limit))
      .reverse();
  }

  const expandedQueryTokens = expandQueryTokens(queryTokens);
  const nowTs = Date.now();
  const scored: Array<{ row: AgentEventRecord; score: number }> = [];

  for (const row of rows) {
    const score = semanticScore(row, rawQuery, queryTokens, expandedQueryTokens, nowTs);
    if (score >= 1.2) {
      scored.push({ row, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.row.ts) - Date.parse(a.row.ts);
  });

  return scored.slice(0, limit).map((entry) => entry.row);
}
