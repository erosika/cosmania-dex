/**
 * COSMANIA DEX -- Server
 *
 * Bun.serve that:
 * 1. Serves static client files from client/
 * 2. Proxies /dex/* to the Cosmania health server
 * 3. /api/chat/:agent -- Mistral-powered agent conversation (Phase 2)
 * 4. /api/voice/:agent -- ElevenLabs TTS (Phase 3)
 *
 * Usage:
 *   COSMANIA_URL=http://localhost:8080 bun run server/main.ts
 */

import { join } from "node:path";
import { statSync } from "node:fs";
import {
  chatWithAgent,
  generateStandup,
  generateGroupChat,
  setAgentModel,
  clearAgentModel,
  getAgentModelInfo,
  type AgentProfile,
  type ExecutedToolCall,
} from "./mistral.ts";
import { generateSpeech, voiceEnabled, listVoices } from "./voice.ts";
import { initWeave } from "./weave.ts";
import { initHoncho, honchoEnabled, loadSessionMessages } from "./honcho.ts";
import { UPLOADS_DIR, uploadRegistry, computeContentHash, rebuildRegistry } from "./uploads.ts";
import {
  appendAgentEvents,
  getRecentAgentEvents,
  searchAgentEvents,
  type AgentEventInput,
} from "./events.ts";

// Recover uploads from disk (survives server restarts)
rebuildRegistry();

// Initialize integrations (no-op if keys not set)
await initWeave();
await initHoncho();

const PORT = parseInt(process.env.DEX_PORT || "3333", 10);
const COSMANIA_URL = process.env.COSMANIA_URL || "http://localhost:8080";

const CLIENT_DIR = join(import.meta.dir, "../client");

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function clampIntEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseAgentList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function sanitizeSessionId(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "dex-autonomy";
}

function toPreview(value: unknown, maxChars = 220): string | null {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (!raw) return null;
    const compact = raw.replace(/\s+/g, " ").trim();
    if (!compact) return null;
    return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact;
  } catch {
    return null;
  }
}

function appendServerEvent(
  message: string,
  options: {
    kind?: string;
    agentName?: string | null;
    dedupeKey?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): void {
  const text = message.trim();
  if (!text) return;
  try {
    appendAgentEvents(
      [
        {
          ts: new Date().toISOString(),
          source: "server",
          kind: options.kind ?? "info",
          message: text,
          agentName: options.agentName ?? null,
          dedupeKey: options.dedupeKey ?? null,
          ...(options.meta ? { meta: options.meta } : {}),
        },
      ],
      "server",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[events] Failed to append server event: ${msg}`);
  }
}

function appendToolCallEvents(
  agentName: string,
  toolCalls: ExecutedToolCall[] | undefined,
  baseMeta: Record<string, unknown> = {},
): void {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
  for (const tc of toolCalls) {
    appendServerEvent(`${agentName} ran ${tc.name} (${tc.durationMs}ms)`, {
      kind: "run",
      agentName,
      dedupeKey: `server-tool:${agentName}:${tc.id}:${tc.durationMs}`,
      meta: {
        ...baseMeta,
        traceId: tc.id ?? null,
        traceName: tc.name ?? null,
        durationMs: typeof tc.durationMs === "number" ? tc.durationMs : null,
        argsPreview: toPreview(tc.args, 240),
        resultPreview: toPreview(tc.result, 240),
      },
    });
  }
}

const AUTONOMY_ENABLED = isTruthy(process.env.DEX_AUTONOMY_ENABLED ?? process.env.AUTONOMY_ENABLED);
const AUTONOMY_INTERVAL_MS = clampIntEnv(process.env.DEX_AUTONOMY_INTERVAL_MS, 45_000, 8_000, 900_000);
const AUTONOMY_ROUNDS = clampIntEnv(process.env.DEX_AUTONOMY_ROUNDS, 1, 1, 3);
const AUTONOMY_HISTORY_LIMIT = clampIntEnv(process.env.DEX_AUTONOMY_HISTORY_LIMIT, 80, 20, 600);
const AUTONOMY_SESSION_ID = sanitizeSessionId(process.env.DEX_AUTONOMY_SESSION_ID || "dex-autonomy");
const AUTONOMY_AGENTS = parseAgentList(process.env.DEX_AUTONOMY_AGENTS);

let autonomyInFlight = false;
let autonomyLastRunAt = 0;
let autonomyRunCount = 0;
let autonomyHistory: Array<{ agent: string; message: string }> = [];

const GROUP_AUTONOMY_ENABLED = isTruthy(process.env.DEX_GROUP_AUTONOMY_ENABLED ?? "1");
const GROUP_AUTONOMY_MIN_MS = clampIntEnv(process.env.DEX_GROUP_AUTONOMY_MIN_MS, 18_000, 5_000, 600_000);
const GROUP_AUTONOMY_MAX_MS = clampIntEnv(process.env.DEX_GROUP_AUTONOMY_MAX_MS, 70_000, 8_000, 900_000);
const GROUP_SESSION_IDLE_TTL_MS = clampIntEnv(process.env.DEX_GROUP_SESSION_IDLE_TTL_MS, 40 * 60_000, 30_000, 6 * 60 * 60_000);
const GROUP_SESSION_MAX_HISTORY = clampIntEnv(process.env.DEX_GROUP_SESSION_MAX_HISTORY, 260, 20, 2000);
const GROUP_SESSION_MAX_MESSAGES = clampIntEnv(process.env.DEX_GROUP_SESSION_MAX_MESSAGES, 900, 80, 6000);
const GROUP_AUTONOMY_SWEEP_MS = clampIntEnv(process.env.DEX_GROUP_AUTONOMY_SWEEP_MS, 2500, 500, 60_000);

type GroupSessionMessageSource = "manual" | "autonomy";

interface GroupSessionMessageRecord {
  id: string;
  ts: string;
  tsMs: number;
  agent: string;
  message: string;
  source: GroupSessionMessageSource;
  toolCalls?: ExecutedToolCall[];
}

interface ActiveGroupSession {
  sessionId: string;
  participants: string[];
  autonomyEnabled: boolean;
  rounds: number;
  history: Array<{ agent: string; message: string }>;
  messages: GroupSessionMessageRecord[];
  inFlight: boolean;
  lastTouchedAt: number;
  lastAutonomyAt: number;
  nextAutonomyAt: number;
  nextSpeakerIndex: number;
}

const activeGroupSessions = new Map<string, ActiveGroupSession>();

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(min + Math.random() * (max - min + 1));
}

function nextGroupAutonomyDelayMs(): number {
  return randomBetween(GROUP_AUTONOMY_MIN_MS, GROUP_AUTONOMY_MAX_MS);
}

function makeGroupMessageRecord(
  agent: string,
  message: string,
  source: GroupSessionMessageSource,
  toolCalls?: ExecutedToolCall[],
): GroupSessionMessageRecord {
  const tsMs = Date.now();
  return {
    id: `gmsg_${tsMs.toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    ts: new Date(tsMs).toISOString(),
    tsMs,
    agent,
    message,
    source,
    ...(Array.isArray(toolCalls) && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function trimGroupSessionState(session: ActiveGroupSession): void {
  if (session.history.length > GROUP_SESSION_MAX_HISTORY) {
    session.history.splice(0, session.history.length - GROUP_SESSION_MAX_HISTORY);
  }
  if (session.messages.length > GROUP_SESSION_MAX_MESSAGES) {
    session.messages.splice(0, session.messages.length - GROUP_SESSION_MAX_MESSAGES);
  }
}

function upsertGroupSession(
  sessionIdRaw: string,
  participants: string[],
  options: { autonomyEnabled?: boolean; rounds?: number } = {},
): ActiveGroupSession {
  const sessionId = sanitizeSessionId(sessionIdRaw);
  const uniqueParticipants = Array.from(
    new Set(
      participants
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const now = Date.now();
  const existing = activeGroupSessions.get(sessionId);
  if (existing) {
    if (uniqueParticipants.length >= 2) {
      existing.participants = uniqueParticipants;
    }
    if (typeof options.autonomyEnabled === "boolean") {
      existing.autonomyEnabled = options.autonomyEnabled;
    }
    if (typeof options.rounds === "number" && Number.isFinite(options.rounds)) {
      existing.rounds = Math.min(3, Math.max(1, Math.floor(options.rounds)));
    }
    existing.lastTouchedAt = now;
    if (existing.autonomyEnabled && existing.nextAutonomyAt <= now) {
      existing.nextAutonomyAt = now + nextGroupAutonomyDelayMs();
    }
    if (existing.participants.length > 0) {
      existing.nextSpeakerIndex = existing.nextSpeakerIndex % existing.participants.length;
    } else {
      existing.nextSpeakerIndex = 0;
    }
    return existing;
  }

  const session: ActiveGroupSession = {
    sessionId,
    participants: uniqueParticipants,
    autonomyEnabled: options.autonomyEnabled !== false,
    rounds: typeof options.rounds === "number"
      ? Math.min(3, Math.max(1, Math.floor(options.rounds)))
      : 1,
    history: [],
    messages: [],
    inFlight: false,
    lastTouchedAt: now,
    lastAutonomyAt: 0,
    nextAutonomyAt: now + nextGroupAutonomyDelayMs(),
    nextSpeakerIndex: 0,
  };
  activeGroupSessions.set(sessionId, session);
  return session;
}

function appendGroupSessionMessages(
  session: ActiveGroupSession,
  lines: Array<{ agent: string; message: string; toolCalls?: ExecutedToolCall[] }>,
  source: GroupSessionMessageSource,
): GroupSessionMessageRecord[] {
  const records: GroupSessionMessageRecord[] = [];
  for (const line of lines) {
    const agent = typeof line.agent === "string" ? line.agent.trim() : "";
    const message = typeof line.message === "string" ? line.message.trim() : "";
    if (!agent || !message) continue;
    const toolCalls = Array.isArray(line.toolCalls) ? line.toolCalls : undefined;
    const record = makeGroupMessageRecord(agent, message, source, toolCalls);
    session.messages.push(record);
    records.push(record);
    if (agent !== "system") {
      session.history.push({ agent, message });
    }
  }
  trimGroupSessionState(session);
  return records;
}

function resolveProfilesForParticipants(
  roster: AgentProfile[],
  participantNames: string[],
): AgentProfile[] {
  const profiles: AgentProfile[] = [];
  for (const name of participantNames) {
    const found = roster.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
    if (found) {
      profiles.push(found);
      continue;
    }
    profiles.push({
      name,
      role: name,
      tagline: "",
      type: "creative",
      state: "healthy",
      bubble: "",
      schedule: "",
      executionTier: "none",
      lastRun: null,
    });
  }
  return profiles;
}

async function runGroupSessionAutonomyTick(
  session: ActiveGroupSession,
  trigger: "timer" | "manual" = "timer",
): Promise<void> {
  if (session.inFlight || !session.autonomyEnabled) return;
  if (session.participants.length < 2) return;

  session.inFlight = true;
  try {
    const roster = await fetchRosterProfiles();
    const profiles = resolveProfilesForParticipants(roster, session.participants);
    if (profiles.length < 2) {
      session.nextAutonomyAt = Date.now() + nextGroupAutonomyDelayMs();
      return;
    }

    const result = await generateGroupChat(
      profiles,
      undefined,
      Math.min(2, Math.max(1, session.rounds)),
      session.history.slice(-AUTONOMY_HISTORY_LIMIT),
      session.sessionId,
      {
        maxSpeakers: 1,
        speakerOffset: session.nextSpeakerIndex,
        participantNames: session.participants,
      },
    );

    appendServerEvent("group session autonomy tick complete", {
      kind: "social",
      dedupeKey: null,
      meta: {
        source: "group-autonomy",
        trigger,
        session: session.sessionId,
        participants: session.participants.join(","),
        messages: result.messages.length,
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
      },
    });

    for (const line of result.messages) {
      const text = typeof line.message === "string" ? line.message.trim() : "";
      if (!text) continue;
      const isSystem = line.agent === "system";
      appendServerEvent(text, {
        kind: isSystem ? "state" : "chat",
        agentName: isSystem ? null : line.agent,
        dedupeKey: null,
        meta: {
          source: "group-autonomy",
          trigger,
          session: session.sessionId,
          participants: session.participants.join(","),
        },
      });
      if (!isSystem) {
        appendToolCallEvents(line.agent, line.toolCalls, {
          source: "group-autonomy",
          trigger,
          session: session.sessionId,
        });
      }
    }

    appendGroupSessionMessages(
      session,
      result.messages.map((line) => ({
        agent: line.agent,
        message: line.message,
        toolCalls: line.toolCalls,
      })),
      "autonomy",
    );
    const agentReplies = result.messages.filter((line) => line.agent !== "system").length;
    if (session.participants.length > 0 && agentReplies > 0) {
      session.nextSpeakerIndex = (session.nextSpeakerIndex + agentReplies) % session.participants.length;
    }
    session.lastAutonomyAt = Date.now();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendServerEvent(`group autonomy failed: ${msg}`, {
      kind: "state",
      dedupeKey: `group-autonomy-failed:${session.sessionId}:${msg.slice(0, 120)}`,
      meta: {
        source: "group-autonomy",
        session: session.sessionId,
      },
    });
  } finally {
    session.inFlight = false;
    session.nextAutonomyAt = Date.now() + nextGroupAutonomyDelayMs();
  }
}

async function sweepGroupSessionAutonomy(): Promise<void> {
  if (!GROUP_AUTONOMY_ENABLED) return;
  const now = Date.now();
  for (const [sessionId, session] of activeGroupSessions.entries()) {
    if (now - session.lastTouchedAt > GROUP_SESSION_IDLE_TTL_MS) {
      activeGroupSessions.delete(sessionId);
      appendServerEvent("group autonomy session expired", {
        kind: "info",
        dedupeKey: `group-autonomy-expired:${sessionId}`,
        meta: {
          source: "group-autonomy",
          session: sessionId,
        },
      });
      continue;
    }
    if (!session.autonomyEnabled || session.inFlight) continue;
    if (session.nextAutonomyAt <= now) {
      void runGroupSessionAutonomyTick(session, "timer");
    }
  }
}

async function fetchRosterProfiles(): Promise<AgentProfile[]> {
  try {
    const res = await fetch(`${COSMANIA_URL}/dex/agents`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as AgentProfile[]) : [];
  } catch {
    return [];
  }
}

function pickAutonomyParticipants(allProfiles: AgentProfile[]): AgentProfile[] {
  const base = AUTONOMY_AGENTS.length > 0
    ? allProfiles.filter((profile) => AUTONOMY_AGENTS.includes(profile.name.toLowerCase()))
    : allProfiles;

  // Prefer agents that are currently active in Cosmania state.
  const active = base.filter((profile) => !profile.circuitOpen && profile.state !== "sleeping");
  const pool = active.length >= 2 ? active : base;

  if (pool.length <= 4) return pool;

  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  return shuffled.slice(0, 4);
}

async function runAutonomyTick(
  trigger: "startup" | "interval" | "manual" = "interval",
): Promise<{ ok: boolean; reason?: string; session?: string; messages?: number }> {
  if (autonomyInFlight) {
    return { ok: false, reason: "in-flight" };
  }

  autonomyInFlight = true;
  try {
    const allProfiles = await fetchRosterProfiles();
    const participants = pickAutonomyParticipants(allProfiles);

    if (participants.length < 2) {
      return { ok: false, reason: "not-enough-participants" };
    }

    const historyTail = autonomyHistory.slice(-AUTONOMY_HISTORY_LIMIT);
    const result = await generateGroupChat(
      participants,
      undefined,
      AUTONOMY_ROUNDS,
      historyTail,
      AUTONOMY_SESSION_ID,
    );

    const participantNames = participants.map((profile) => profile.name);
    appendServerEvent("autonomous group tick complete", {
      kind: "social",
      dedupeKey: null,
      meta: {
        trigger,
        session: result.session,
        participants: participantNames.join(","),
        rounds: AUTONOMY_ROUNDS,
        messages: result.messages.length,
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
      },
    });

    for (const line of result.messages) {
      const text = typeof line.message === "string" ? line.message.trim() : "";
      if (!text) continue;
      const isSystem = line.agent === "system";
      appendServerEvent(text, {
        kind: isSystem ? "state" : "chat",
        agentName: isSystem ? null : line.agent,
        dedupeKey: null,
        meta: {
          source: "autonomy",
          trigger,
          session: result.session,
        },
      });
      if (!isSystem) {
        appendToolCallEvents(line.agent, line.toolCalls, {
          source: "autonomy",
          trigger,
          session: result.session,
        });
      }
    }

    const additions = result.messages
      .filter((line) => line.agent !== "system")
      .map((line) => ({
        agent: line.agent,
        message: line.message,
      }))
      .filter((line) => line.message && line.message.trim().length > 0);

    if (additions.length > 0) {
      autonomyHistory = autonomyHistory.concat(additions).slice(-AUTONOMY_HISTORY_LIMIT);
    }

    autonomyRunCount += 1;
    autonomyLastRunAt = Date.now();
    return { ok: true, session: result.session, messages: result.messages.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendServerEvent(`autonomy tick failed: ${msg}`, {
      kind: "state",
      dedupeKey: `autonomy-failed:${msg.slice(0, 120)}`,
      meta: { trigger },
    });
    return { ok: false, reason: msg };
  } finally {
    autonomyInFlight = false;
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".gif": "image/gif",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

/** Proxy a request to the Cosmania health server. */
async function proxyCosmania(pathname: string): Promise<Response> {
  try {
    const upstream = await fetch(`${COSMANIA_URL}${pathname}`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return Response.json(
      { error: "Cosmania upstream unavailable", url: `${COSMANIA_URL}${pathname}` },
      { status: 502 },
    );
  }
}

/** Serve a static file from the client directory. */
function serveStatic(pathname: string): Response {
  const filePath = join(CLIENT_DIR, pathname === "/" ? "index.html" : pathname);

  try {
    // Prevent directory traversal
    if (!filePath.startsWith(CLIENT_DIR)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      // Try index.html inside directory
      const indexPath = join(filePath, "index.html");
      const indexFile = Bun.file(indexPath);
      return new Response(indexFile, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    return new Response(file, {
      headers: {
        "Content-Type": getMimeType(filePath),
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Proxy /dex/* to Cosmania
    if (pathname.startsWith("/dex/")) {
      return proxyCosmania(pathname);
    }

    // Proxy health/status for debugging
    if (pathname === "/health" || pathname === "/status") {
      return proxyCosmania(pathname);
    }

    // ----- Photo Upload API -----

    // POST /api/upload/photo -- upload a JPEG for photoblogger analysis
    if (pathname === "/api/upload/photo" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const file = formData.get("photo");

        if (!file || !(file instanceof File)) {
          return Response.json(
            { error: "photo file is required (multipart field: photo)" },
            { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
          );
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const contentHash = computeContentHash(buffer);
        const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase() || ".jpg";
        const id = `upload_${Date.now()}_${contentHash.slice(0, 8)}`;
        const filename = `${id}${ext}`;
        const filePath = join(UPLOADS_DIR, filename);

        await Bun.write(filePath, buffer);

        const entry = {
          id,
          filename: file.name,
          path: filePath,
          size: buffer.byteLength,
          contentHash,
          uploadedAt: new Date().toISOString(),
        };

        uploadRegistry.set(id, entry);

        console.log(`[upload] ${file.name} -> ${filename} (${(buffer.byteLength / 1024).toFixed(0)}KB, hash ${contentHash.slice(0, 12)}...)`);
        appendServerEvent(`photo uploaded: ${file.name}`, {
          kind: "info",
          agentName: "photoblogger",
          dedupeKey: `upload:${id}`,
          meta: {
            uploadId: id,
            filename: file.name,
            sizeKb: Math.round(buffer.byteLength / 1024),
            contentHash: contentHash.slice(0, 12),
          },
        });

        return Response.json(entry, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ----- Model Override API -----

    const modelMatch = pathname.match(/^\/api\/agent\/([a-z]+)\/model$/);
    if (modelMatch) {
      const agentName = modelMatch[1]!;

      if (req.method === "GET") {
        const info = getAgentModelInfo(agentName);
        return Response.json(info, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      if (req.method === "POST") {
        try {
          const body = await req.json() as { model?: string; reset?: boolean };

          if (body.reset) {
            clearAgentModel(agentName);
            const info = getAgentModelInfo(agentName);
            return Response.json(info, {
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }

          if (!body.model) {
            return Response.json(
              { error: "model or reset is required" },
              { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
            );
          }

          const result = setAgentModel(agentName, body.model);
          if (!result.ok) {
            return Response.json(
              { error: result.error },
              { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
            );
          }

          const info = getAgentModelInfo(agentName);
          return Response.json(info, {
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return Response.json({ error: msg }, {
            status: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
      }
    }

    // ----- Event Log API -----

    // GET /api/events -- fetch recent persisted event stream
    if (pathname === "/api/events" && req.method === "GET") {
      const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
      const limit = Number.isFinite(parsedLimit) ? Math.min(5000, Math.max(1, parsedLimit)) : 200;
      const agentName = (url.searchParams.get("agent") ?? "").trim() || undefined;
      const kindsParam = (url.searchParams.get("kinds") ?? "").trim();
      const sinceRaw = (url.searchParams.get("since") ?? "").trim();
      const untilRaw = (url.searchParams.get("until") ?? "").trim();
      const sinceTsParsed = Date.parse(sinceRaw);
      const untilTsParsed = Date.parse(untilRaw);
      const sinceTs = Number.isFinite(sinceTsParsed) ? sinceTsParsed : undefined;
      const untilTs = Number.isFinite(untilTsParsed) ? untilTsParsed : undefined;
      const kinds = kindsParam
        ? kindsParam.split(",").map((v) => v.trim()).filter(Boolean)
        : undefined;

      const events = getRecentAgentEvents({ limit, agentName, kinds, sinceTs, untilTs });
      return Response.json({ events }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // GET /api/events/search -- semantic/exact search over persisted events
    if (pathname === "/api/events/search" && req.method === "GET") {
      const query = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
      if (!query) {
        return Response.json(
          { events: [], query: "", semantic: true },
          { headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
      const limit = Number.isFinite(parsedLimit) ? Math.min(5000, Math.max(1, parsedLimit)) : 200;
      const agentName = (url.searchParams.get("agent") ?? "").trim() || undefined;
      const kindsParam = (url.searchParams.get("kinds") ?? "").trim();
      const sinceRaw = (url.searchParams.get("since") ?? "").trim();
      const untilRaw = (url.searchParams.get("until") ?? "").trim();
      const semanticRaw = (url.searchParams.get("semantic") ?? "1").trim().toLowerCase();
      const sinceTsParsed = Date.parse(sinceRaw);
      const untilTsParsed = Date.parse(untilRaw);
      const sinceTs = Number.isFinite(sinceTsParsed) ? sinceTsParsed : undefined;
      const untilTs = Number.isFinite(untilTsParsed) ? untilTsParsed : undefined;
      const semantic = !(semanticRaw === "0" || semanticRaw === "false" || semanticRaw === "off");
      const kinds = kindsParam
        ? kindsParam.split(",").map((v) => v.trim()).filter(Boolean)
        : undefined;

      const events = searchAgentEvents({
        query,
        limit,
        agentName,
        kinds,
        semantic,
        sinceTs,
        untilTs,
      });
      return Response.json(
        { events, query, semantic },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // POST /api/events -- append one or many events to durable JSONL log
    if (pathname === "/api/events" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => null);

        let incoming: AgentEventInput[] = [];
        if (Array.isArray(body)) {
          incoming = body as AgentEventInput[];
        } else if (body && typeof body === "object") {
          const payload = body as { events?: unknown; event?: unknown };
          if (Array.isArray(payload.events)) {
            incoming = payload.events as AgentEventInput[];
          } else if (payload.event && typeof payload.event === "object") {
            incoming = [payload.event as AgentEventInput];
          }
        }

        if (incoming.length === 0) {
          return Response.json(
            { error: "events array is required" },
            { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
          );
        }

        const persisted = appendAgentEvents(incoming, "client");
        return Response.json(
          {
            ok: true,
            persisted: persisted.length,
            latestTs: persisted[persisted.length - 1]?.ts ?? null,
          },
          { headers: { "Access-Control-Allow-Origin": "*" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // ----- Chat API -----

    // CORS preflight
    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // GET /api/chat/:agent/history -- load session history from Honcho
    const historyMatch = pathname.match(/^\/api\/chat\/([a-z]+)\/history$/);
    if (historyMatch && req.method === "GET") {
      const agentName = historyMatch[1]!;

      if (!honchoEnabled()) {
        return Response.json({ messages: [], summary: null }, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      try {
        const result = await loadSessionMessages(agentName);
        return Response.json(result, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg, messages: [], summary: null }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // POST /api/chat/:agent -- chat with an agent
    const chatMatch = pathname.match(/^\/api\/chat\/([a-z]+)$/);
    if (chatMatch && req.method === "POST") {
      const agentName = chatMatch[1]!;

      try {
        const body = await req.json() as { message: string; history?: Array<{ role: string; content: string }>; uploadId?: string };
        if (!body.message) {
          return Response.json({ error: "message is required" }, { status: 400 });
        }

        // If an upload ID is attached, prepend context to the message so the agent knows
        let enrichedMessage = body.message;
        if (body.uploadId) {
          const upload = uploadRegistry.get(body.uploadId);
          if (upload) {
            enrichedMessage = `[Photo uploaded -- filename: ${upload.filename}, size: ${(upload.size / 1024).toFixed(0)}KB. Use upload_id "${upload.id}" for all tool calls on this photo.]\n\n${body.message}`;
          }
        }

        // Fetch agent profile from Cosmania
        let profile: AgentProfile | null = null;
        try {
          const res = await fetch(`${COSMANIA_URL}/dex/agents/${agentName}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) profile = await res.json() as AgentProfile;
        } catch { /* use fallback */ }

        if (!profile) {
          profile = {
            name: agentName, role: agentName, tagline: "", type: "creative",
            state: "healthy", bubble: "", schedule: "", executionTier: "none", lastRun: null,
          };
        }

        const result = await chatWithAgent(
          agentName,
          enrichedMessage,
          profile,
          (body.history ?? []) as Array<{ role: "user" | "assistant" | "system"; content: string }>,
        );

        const responseText = typeof result.response === "string" ? result.response.trim() : "";
        if (responseText) {
          appendServerEvent(responseText, {
            kind: "chat",
            agentName,
            dedupeKey: null,
            meta: {
              channel: "dex-chat",
              model: result.model,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              openUrl: result.openUrl ?? null,
            },
          });
        }
        appendToolCallEvents(agentName, result.toolCalls, {
          channel: "dex-chat",
          model: result.model,
        });

        return Response.json(result, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendServerEvent(`report failed: ${msg}`, {
          kind: "state",
          agentName,
          dedupeKey: `chat-failed:${agentName}:${msg.slice(0, 96)}`,
          meta: { channel: "dex-chat" },
        });
        return Response.json({ error: msg }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // POST /api/standup -- generate multi-agent standup
    if (pathname === "/api/standup" && req.method === "POST") {
      try {
        const body = await req.json().catch(() => ({})) as { maxAgents?: number };

        let profiles: AgentProfile[] = [];
        try {
          const res = await fetch(`${COSMANIA_URL}/dex/agents`, {
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) profiles = await res.json() as AgentProfile[];
        } catch { /* empty roster */ }

        if (profiles.length === 0) {
          return Response.json({ error: "No agents available" }, { status: 502 });
        }

        const lines = await generateStandup(profiles, body.maxAgents);
        appendServerEvent("standup generated", {
          kind: "social",
          dedupeKey: null,
          meta: { lines: lines.length },
        });
        return Response.json({ lines }, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // POST /api/voice/:agent -- generate speech for an agent
    const voiceMatch = pathname.match(/^\/api\/voice\/([a-z]+)$/);
    if (voiceMatch && req.method === "POST") {
      const agentName = voiceMatch[1]!;

      if (!voiceEnabled()) {
        return Response.json(
          { error: "ELEVENLABS_API_KEY not set" },
          { status: 503, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      try {
        const body = await req.json() as { text?: string };
        let text = body.text;

        // If no text provided, use the agent's bubble
        if (!text) {
          try {
            const res = await fetch(`${COSMANIA_URL}/dex/agents/${agentName}`, {
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const profile = await res.json() as AgentProfile;
              text = profile.bubble || `${agentName} has nothing to say.`;
            }
          } catch { /* fallback */ }
          text = text || `${agentName} reporting in.`;
        }

        // Get agent type for voice settings
        let agentType = "infrastructure";
        try {
          const res = await fetch(`${COSMANIA_URL}/dex/agents/${agentName}`, {
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const profile = await res.json() as AgentProfile;
            agentType = profile.type;
          }
        } catch { /* use default */ }

        const result = await generateSpeech(agentName, text, agentType);

        return new Response(result.audio, {
          headers: {
            "Content-Type": result.contentType,
            "Content-Length": String(result.audio.byteLength),
            "X-Voice-Name": result.voiceName,
            "X-Character-Count": String(result.characterCount),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-Voice-Name, X-Character-Count",
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // GET /api/voices -- list voice registry
    if (pathname === "/api/voices" && req.method === "GET") {
      const voices = await listVoices();
      return Response.json({
        enabled: voiceEnabled(),
        voices,
      }, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // GET /api/group/updates -- poll incremental messages for an existing group session
    if (pathname === "/api/group/updates" && req.method === "GET") {
      const sessionRaw = (url.searchParams.get("session") ?? "").trim();
      if (!sessionRaw) {
        return Response.json(
          { error: "session query is required" },
          { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const sessionId = sanitizeSessionId(sessionRaw);
      const session = activeGroupSessions.get(sessionId);
      if (!session) {
        return Response.json(
          { session: sessionId, known: false, messages: [] },
          { headers: { "Access-Control-Allow-Origin": "*" } },
        );
      }

      const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "80", 10);
      const limit = Number.isFinite(parsedLimit) ? Math.min(400, Math.max(1, parsedLimit)) : 80;
      const sinceRaw = (url.searchParams.get("since") ?? "").trim();
      const sinceParsed = Date.parse(sinceRaw);
      const sinceTs = Number.isFinite(sinceParsed) ? sinceParsed : 0;

      session.lastTouchedAt = Date.now();
      const updates = session.messages
        .filter((record) => record.tsMs > sinceTs)
        .slice(-limit)
        .map((record) => ({
          id: record.id,
          ts: record.ts,
          agent: record.agent,
          message: record.message,
          source: record.source,
          ...(Array.isArray(record.toolCalls) && record.toolCalls.length > 0
            ? { toolCalls: record.toolCalls }
            : {}),
        }));

      return Response.json(
        {
          session: session.sessionId,
          known: true,
          autonomyEnabled: session.autonomyEnabled,
          inFlight: session.inFlight,
          nextAutonomyAt: session.nextAutonomyAt ? new Date(session.nextAutonomyAt).toISOString() : null,
          messages: updates,
        },
        {
          headers: { "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    // POST /api/group -- multi-agent group conversation
    if (pathname === "/api/group" && req.method === "POST") {
      try {
        const body = await req.json() as {
          agents: string[];
          message?: string;
          rounds?: number;
          history?: {agent: string, message: string}[];
          sessionId?: string;
          autonomy?: boolean;
          maxImmediateReplies?: number;
        };

        if (!body.agents || !Array.isArray(body.agents) || body.agents.length < 2) {
          return Response.json(
            { error: "agents array with at least 2 names is required" },
            { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
          );
        }

        // Fetch profiles for requested agents
        let allProfiles: AgentProfile[] = [];
        try {
          const res = await fetch(`${COSMANIA_URL}/dex/agents`, {
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) allProfiles = await res.json() as AgentProfile[];
        } catch { /* empty roster */ }

        // Filter to requested agents, preserving request order
        const profiles = body.agents
          .map((name) => allProfiles.find((p) => p.name === name))
          .filter((p): p is AgentProfile => p !== undefined);

        // Fill in any missing agents with fallback profiles
        for (const name of body.agents) {
          if (!profiles.find((p) => p.name === name)) {
            profiles.push({
              name, role: name, tagline: "", type: "creative",
              state: "healthy", bubble: "", schedule: "", executionTier: "none", lastRun: null,
            });
          }
        }

        const requestedSessionId = typeof body.sessionId === "string" && body.sessionId.trim()
          ? body.sessionId.trim()
          : "";
        const requestedSessionMapId = requestedSessionId ? sanitizeSessionId(requestedSessionId) : "";
        const existingSession = requestedSessionMapId ? activeGroupSessions.get(requestedSessionMapId) : undefined;
        const parsedImmediateReplies = Number.parseInt(String(body.maxImmediateReplies ?? "1"), 10);
        const maxImmediateReplies = Number.isFinite(parsedImmediateReplies)
          ? Math.min(4, Math.max(1, parsedImmediateReplies))
          : 1;

        const result = await generateGroupChat(
          profiles,
          body.message,
          body.rounds ?? 1,
          body.history ?? [],
          requestedSessionId || undefined,
          {
            maxSpeakers: maxImmediateReplies,
            speakerOffset: existingSession?.nextSpeakerIndex ?? 0,
            participantNames: body.agents,
          },
        );

        appendServerEvent("group conversation updated", {
          kind: "social",
          dedupeKey: null,
          meta: {
            session: result.session,
            participants: body.agents.join(","),
            rounds: body.rounds ?? 1,
            immediateReplies: maxImmediateReplies,
            messages: result.messages.length,
            totalInputTokens: result.totalInputTokens,
            totalOutputTokens: result.totalOutputTokens,
          },
        });

        for (const line of result.messages) {
          const text = typeof line.message === "string" ? line.message.trim() : "";
          if (!text) continue;
          const isSystem = line.agent === "system";
          appendServerEvent(text, {
            kind: isSystem ? "state" : "chat",
            agentName: isSystem ? null : line.agent,
            dedupeKey: null,
            meta: {
              source: "api-group",
              session: result.session,
              participants: body.agents.join(","),
            },
          });
          if (!isSystem) {
            appendToolCallEvents(line.agent, line.toolCalls, {
              source: "api-group",
              session: result.session,
            });
          }
        }

        const session = upsertGroupSession(
          result.session,
          body.agents,
          {
            autonomyEnabled: body.autonomy !== false,
            rounds: body.rounds ?? 1,
          },
        );
        const normalizedUserMessage = typeof body.message === "string" ? body.message.trim() : "";
        const userRecords = normalizedUserMessage
          ? appendGroupSessionMessages(
            session,
            [{ agent: "eri", message: normalizedUserMessage }],
            "manual",
          )
          : [];
        const agentRecords = appendGroupSessionMessages(
          session,
          result.messages.map((line) => ({
            agent: line.agent,
            message: line.message,
            toolCalls: line.toolCalls,
          })),
          "manual",
        );
        const records = userRecords.concat(agentRecords);
        trimGroupSessionState(session);
        const repliesThisTurn = result.messages.filter((line) => line.agent !== "system").length;
        if (session.participants.length > 0 && repliesThisTurn > 0) {
          session.nextSpeakerIndex = (session.nextSpeakerIndex + repliesThisTurn) % session.participants.length;
        }
        session.lastTouchedAt = Date.now();
        if (session.autonomyEnabled) {
          session.nextAutonomyAt = Date.now() + nextGroupAutonomyDelayMs();
        }

        return Response.json({ ...result, records }, {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // GET /api/autonomy/status -- inspect autonomous loop state
    if (pathname === "/api/autonomy/status" && req.method === "GET") {
      return Response.json(
        {
          enabled: AUTONOMY_ENABLED,
          inFlight: autonomyInFlight,
          intervalMs: AUTONOMY_INTERVAL_MS,
          rounds: AUTONOMY_ROUNDS,
          sessionId: AUTONOMY_SESSION_ID,
          configuredAgents: AUTONOMY_AGENTS,
          runCount: autonomyRunCount,
          historySize: autonomyHistory.length,
          lastRunAt: autonomyLastRunAt ? new Date(autonomyLastRunAt).toISOString() : null,
        },
        {
          headers: { "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    // POST /api/autonomy/run -- trigger one autonomous cycle immediately
    if (pathname === "/api/autonomy/run" && req.method === "POST") {
      const result = await runAutonomyTick("manual");
      return Response.json(result, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Static file serving
    return serveStatic(pathname);
  },
});

console.log(`[cosmania-dex] Server on http://localhost:${PORT}`);
console.log(`[cosmania-dex] Proxying /dex/* to ${COSMANIA_URL}`);

if (AUTONOMY_ENABLED) {
  console.log(
    `[autonomy] Enabled -- interval ${AUTONOMY_INTERVAL_MS}ms, rounds ${AUTONOMY_ROUNDS}, session ${AUTONOMY_SESSION_ID}`,
  );
  if (AUTONOMY_AGENTS.length > 0) {
    console.log(`[autonomy] Restricted to: ${AUTONOMY_AGENTS.join(", ")}`);
  }
  appendServerEvent("autonomy loop online", {
    kind: "info",
    dedupeKey: "autonomy-loop-online",
    meta: {
      intervalMs: AUTONOMY_INTERVAL_MS,
      rounds: AUTONOMY_ROUNDS,
      session: AUTONOMY_SESSION_ID,
      agents: AUTONOMY_AGENTS.length > 0 ? AUTONOMY_AGENTS.join(",") : "auto",
    },
  });
  setTimeout(() => {
    void runAutonomyTick("startup");
  }, 2200);
  setInterval(() => {
    void runAutonomyTick("interval");
  }, AUTONOMY_INTERVAL_MS);
}

if (GROUP_AUTONOMY_ENABLED) {
  console.log(
    `[group-autonomy] Enabled -- random interval ${GROUP_AUTONOMY_MIN_MS}-${GROUP_AUTONOMY_MAX_MS}ms, idle TTL ${GROUP_SESSION_IDLE_TTL_MS}ms`,
  );
  setInterval(() => {
    void sweepGroupSessionAutonomy();
  }, GROUP_AUTONOMY_SWEEP_MS);
}
