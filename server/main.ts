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
import { chatWithAgent, generateStandup, generateGroupChat, setAgentModel, clearAgentModel, getAgentModelInfo, type AgentProfile } from "./mistral.ts";
import { generateSpeech, voiceEnabled, listVoices } from "./voice.ts";
import { initWeave } from "./weave.ts";
import { initHoncho, honchoEnabled, loadSessionMessages } from "./honcho.ts";
import { UPLOADS_DIR, uploadRegistry, computeContentHash } from "./uploads.ts";
import {
  appendAgentEvents,
  getRecentAgentEvents,
  searchAgentEvents,
  type AgentEventInput,
} from "./events.ts";

// Initialize integrations (no-op if keys not set)
await initWeave();
await initHoncho();

const PORT = parseInt(process.env.DEX_PORT || "3333", 10);
const COSMANIA_URL = process.env.COSMANIA_URL || "http://localhost:8080";

const CLIENT_DIR = join(import.meta.dir, "../client");

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
            enrichedMessage = `[Photo uploaded: ${upload.filename} (${(upload.size / 1024).toFixed(0)}KB, upload_id: ${upload.id})]\n\n${body.message}`;
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

        return Response.json(result, {
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

    // POST /api/group -- multi-agent group conversation
    if (pathname === "/api/group" && req.method === "POST") {
      try {
        const body = await req.json() as {
          agents: string[];
          message?: string;
          rounds?: number;
          history?: {agent: string, message: string}[];
          sessionId?: string;
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

        const result = await generateGroupChat(
          profiles,
          body.message,
          body.rounds ?? 1,
          body.history ?? [],
          body.sessionId,
        );

        return Response.json(result, {
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

    // Static file serving
    return serveStatic(pathname);
  },
});

console.log(`[cosmania-dex] Server on http://localhost:${PORT}`);
console.log(`[cosmania-dex] Proxying /dex/* to ${COSMANIA_URL}`);
