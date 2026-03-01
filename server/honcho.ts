/**
 * Honcho Integration -- Persistent agent memory for the DEX.
 *
 * Session architecture:
 *   Workspace:  "cosmania-dex"
 *   Peer:       "eri" (main peer -- all conversations flow through eri)
 *   Agents:     each agent is its own peer (sentinel, protector, etc.)
 *
 * Sessions are dynamic and continuous:
 *   "dex:sentinel"              -- eri <-> sentinel 1:1
 *   "dex:sentinel+dreamer"      -- sentinel & dreamer pair (eri can interject)
 *   "dex:campfire"              -- all agents open floor
 *   "dex:coder+observer+scribe" -- any N-agent group
 *
 * Every message is recorded. Memory builds per-session.
 * Agents in the same session develop shared context over time.
 *
 * Env: HONCHO_API_KEY (required)
 *      HONCHO_WORKSPACE (default: "cosmania-dex")
 */

import { Honcho } from "@honcho-ai/sdk";

const MAIN_PEER = "eri";

let _honcho: Honcho | null = null;
let _initialized = false;

// ---- Client ----

function getHoncho(): Honcho {
  if (!_honcho) {
    const apiKey = process.env.HONCHO_API_KEY;
    const workspace = process.env.HONCHO_WORKSPACE ?? "cosmania-dex";

    if (!apiKey) {
      throw new Error("HONCHO_API_KEY not set");
    }

    _honcho = new Honcho({
      apiKey,
      baseURL: "https://api.honcho.dev/v3",
      workspaceId: workspace,
    });
  }
  return _honcho;
}

/**
 * Initialize Honcho. No-op if HONCHO_API_KEY not set.
 */
export async function initHoncho(): Promise<boolean> {
  if (!process.env.HONCHO_API_KEY) {
    console.log("[honcho] HONCHO_API_KEY not set -- memory disabled");
    return false;
  }

  try {
    const honcho = getHoncho();
    await honcho.peer(MAIN_PEER);
    _initialized = true;
    console.log(`[honcho] Memory enabled -- peer: ${MAIN_PEER}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[honcho] Failed to initialize: ${msg}`);
    return false;
  }
}

export function honchoEnabled(): boolean {
  return _initialized;
}

// ---- Session Naming ----

/**
 * Deterministic session key from a set of agent names.
 * Sorted alphabetically so the same combo always maps to the same session.
 * Session IDs must match /^[a-zA-Z0-9_-]+$/ (no colons or plus signs).
 *
 *   sessionKey(["sentinel"])                -> "dex-sentinel"
 *   sessionKey(["dreamer", "sentinel"])     -> "dex-dreamer_sentinel"
 *   sessionKey(["all"])                     -> "dex-campfire"
 */
export function sessionKey(agents: string[]): string {
  if (agents.length === 0) return "dex-campfire";
  const sorted = [...agents].sort();
  return `dex-${sorted.join("_")}`;
}

/**
 * Get or create a Honcho session by key.
 */
async function getSession(agents: string[]) {
  const honcho = getHoncho();
  const key = sessionKey(agents);
  return honcho.session(key);
}

// ---- Agent Identity Context ----

const ALIGNMENT_QUERIES: Record<string, string[]> = {
  sentinel: ["What does eri consider critical infrastructure to monitor?"],
  protector: ["What are eri's OPSEC boundaries and privacy expectations?"],
  treasurer: ["What are eri's financial priorities and budget philosophy?"],
  dreamer: [
    "How does eri think about connections between ideas?",
    "What is eri's intellectual style?",
  ],
  coder: ["What are eri's engineering standards and code quality expectations?"],
  scribe: ["What is eri's writing voice and communication style?"],
  observer: [
    "What has eri been working on recently?",
    "What patterns emerge across eri's activity?",
  ],
  director: ["What are eri's visual and cinematic standards?"],
  composer: ["What are eri's musical and sonic preferences?"],
  photoblogger: ["What are eri's photographic preferences and visual style?"],
  vitals: ["What are eri's health priorities and wellness goals?"],
  eros: ["How does eri relate to embodiment and sensation?"],
};

const SEARCH_QUERIES: Record<string, string> = {
  sentinel: "infrastructure health monitoring system status",
  protector: "security privacy boundaries sensitive information",
  treasurer: "budget spending financial priorities cost tracking",
  dreamer: "ideas connections concepts thinking patterns",
  coder: "engineering architecture patterns standards code",
  scribe: "writing communication documentation",
  observer: "development activity patterns priorities",
  director: "video editing visual narrative cinematic",
  composer: "music audio sound production",
  photoblogger: "photography cameras composition curation",
  vitals: "health wellness sleep biometrics recovery",
  eros: "pleasure embodiment sensation desire healing",
};

export interface AgentContext {
  peerCard: string | null;
  alignment: string[];
  recentContext: string | null;
}

/**
 * Load Honcho identity context for an agent.
 *
 * Three layers:
 *   1. Peer card (eri's curated identity -- stable foundation)
 *   2. Dialectic alignment (synthesized from ALL conclusions)
 *   3. Recent context (semantic search, role-scoped)
 */
export async function loadAgentContext(agentName: string): Promise<AgentContext> {
  const honcho = getHoncho();
  const eriPeer = await honcho.peer(MAIN_PEER);

    // Layer 1: Peer card
  let peerCard: string | null = null;
  let ccEriPeer: any = null;
  let hasCcPeer = false;
  
  try {
    // Try to get peer card from claude-code first since it's richer
    const ccHoncho = new Honcho({
      apiKey: process.env.HONCHO_API_KEY!,
      baseURL: "https://api.honcho.dev/v3",
      workspaceId: "claude-code",
    });
    ccEriPeer = await ccHoncho.peer(MAIN_PEER);
    hasCcPeer = true;
    
    const card = await ccEriPeer.getCard();
    if (card && card.length > 0) {
      peerCard = card.join("\n");
    }
  } catch (e) {
    // console.warn(`[honcho] Failed to get claude-code peer card:`, e);
  }
  
  if (!peerCard) {
    try {
      const card = await eriPeer.getCard();
      if (card && card.length > 0) {
        peerCard = card.join("\n");
      }
    } catch {
      // No card yet
    }
  }

  // Layer 2: Dialectic alignment queries (parallel)
  const queries = ALIGNMENT_QUERIES[agentName] ?? [];
  const alignment: string[] = [];

  // We'll load alignment from claude-code later in layer 3 to avoid duplicating the honcho connection
  // if we can't find it there, we will load from dex

  // Layer 3: Scoped representation
  let recentContext: string | null = null;
  const searchQuery = SEARCH_QUERIES[agentName];
  
  // Get representation from the claude-code workspace if possible, or fall back to dex
  if (hasCcPeer) {
    try {
      // Load alignment queries from claude-code first
      if (queries.length > 0) {
        const ccResults = await Promise.allSettled(
          queries.map((q) => ccEriPeer.chat(q)),
        );
        for (const result of ccResults) {
          if (result.status === "fulfilled" && result.value) {
            alignment.push(result.value);
          }
        }
      }
      
      const ccRecentContext = await ccEriPeer.representation({
        ...(searchQuery ? { searchQuery, searchTopK: 10 } : {}),
        includeMostFrequent: true,
        maxConclusions: 15,
      });
      
      if (ccRecentContext && ccRecentContext.length > 0) {
        recentContext = ccRecentContext;
      }
    } catch (e) {
      // console.warn(`[honcho] Failed to get claude-code representation for ${agentName}:`, e);
    }
  }
  
  // If we didn't get alignment from claude-code, try local dex workspace
  if (alignment.length === 0 && queries.length > 0) {
    const results = await Promise.allSettled(
      queries.map((q) => eriPeer.chat(q)),
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        alignment.push(result.value);
      }
    }
  }
  
  // If we didn't get any context from claude-code, try the local dex workspace
  if (!recentContext) {
    try {
      recentContext = await eriPeer.representation({
        ...(searchQuery ? { searchQuery, searchTopK: 10 } : {}),
        includeMostFrequent: true,
        maxConclusions: 15,
      });
    } catch {
      // Not enough data yet
    }
  }

  return { peerCard, alignment, recentContext };
}

/**
 * Format Honcho context as system prompt sections.
 */
export function formatContextForPrompt(ctx: AgentContext): string {
  const parts: string[] = [];

  if (ctx.peerCard) {
    parts.push("## eri's Identity");
    parts.push(ctx.peerCard);
    parts.push("");
  }

  if (ctx.alignment.length > 0) {
    parts.push("## Understanding of eri");
    for (const a of ctx.alignment) {
      parts.push(a);
      parts.push("");
    }
  }

  if (ctx.recentContext) {
    parts.push("## Recent Context");
    parts.push(ctx.recentContext);
    parts.push("");
  }

  return parts.join("\n");
}

// ---- Session History ----

/**
 * Load conversation history from a Honcho session.
 * Uses session.context() which provides summary + recent messages,
 * then converts to OpenAI-format {role, content} pairs.
 *
 * Returns messages suitable for direct insertion into a chat API call.
 * Messages from the agent peer are "assistant"; from eri are "user".
 * Summary (if any) is returned separately.
 */
export async function loadSessionMessages(
  agentName: string,
): Promise<{ messages: Array<{ role: string; content: string }>; summary: string | null }> {
  if (!_initialized) return { messages: [], summary: null };

  const honcho = getHoncho();
  const agentPeer = await honcho.peer(agentName);
  const session = await getSession([agentName]);

  const ctx = await session.context({
    summary: true,
    peerPerspective: agentPeer,
    peerTarget: MAIN_PEER,
    tokens: 4000,
  });

  // Convert to OpenAI format: agent's messages become "assistant", eri's become "user"
  const openaiMessages = ctx.toOpenAI(agentPeer);

  // Filter out system messages (summary/representation) -- we handle those ourselves
  const chatMessages = openaiMessages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const summary = ctx.summary?.content ?? null;

  return { messages: chatMessages, summary };
}

// ---- Conversation Recording ----

/**
 * Record a 1:1 chat exchange (eri <-> agent).
 * Session: "dex:{agentName}"
 */
export async function recordExchange(
  agentName: string,
  userMessage: string,
  agentResponse: string,
): Promise<void> {
  const honcho = getHoncho();
  const eriPeer = await honcho.peer(MAIN_PEER);
  const agentPeer = await honcho.peer(agentName, {
    metadata: { type: "cosmania-agent", source: "dex" },
  });
  const session = await getSession([agentName]);

  await session.addMessages([
    eriPeer.message(userMessage, {
      metadata: { channel: "dex-chat", target: agentName },
    }),
    agentPeer.message(agentResponse, {
      metadata: { channel: "dex-chat", source: agentName },
    }),
  ]);
}

/**
 * Record a message in a group session.
 * Session key is derived from the full participant list.
 *
 * @param participants - all agents in this group (determines session)
 * @param speakerName - who said this message ("eri" or an agent name)
 * @param content - message content
 */
export async function recordGroupMessage(
  participants: string[],
  speakerName: string,
  content: string,
): Promise<void> {
  const honcho = getHoncho();
  const speaker = await honcho.peer(speakerName, {
    metadata: speakerName === MAIN_PEER
      ? {}
      : { type: "cosmania-agent", source: "dex" },
  });
  const session = await getSession(participants);

  await session.addMessages([
    speaker.message(content, {
      metadata: {
        channel: "dex-group",
        participants: participants.join(","),
        speaker: speakerName,
      },
    }),
  ]);
}

/**
 * Search Honcho memory for information relevant to a query.
 * Tries claude-code workspace first (richer data), falls back to cosmania-dex.
 * Used by the `recall_memory` tool in agent chat.
 */
export async function searchHonchoMemory(
  query: string,
): Promise<{ source: string; content: string } | null> {
  if (!_initialized) return null;

  // Try claude-code workspace first
  try {
    const ccHoncho = new Honcho({
      apiKey: process.env.HONCHO_API_KEY!,
      baseURL: "https://api.honcho.dev/v3",
      workspaceId: "claude-code",
    });
    const ccPeer = await ccHoncho.peer(MAIN_PEER);
    const result = await ccPeer.representation({
      searchQuery: query,
      searchTopK: 5,
      maxConclusions: 5,
    });
    if (result && result.length > 0) {
      return { source: "claude-code", content: result };
    }
  } catch {
    // Fall through to dex workspace
  }

  // Fall back to cosmania-dex workspace
  try {
    const honcho = getHoncho();
    const eriPeer = await honcho.peer(MAIN_PEER);
    const result = await eriPeer.representation({
      searchQuery: query,
      searchTopK: 5,
      maxConclusions: 5,
    });
    if (result && result.length > 0) {
      return { source: "cosmania-dex", content: result };
    }
  } catch {
    // No results
  }

  return null;
}

/**
 * Write a conclusion from an agent.
 * Goes to the agent's 1:1 session with eri.
 */
export async function writeConclusion(
  agentName: string,
  content: string,
): Promise<void> {
  const honcho = getHoncho();
  const agentPeer = await honcho.peer(agentName);
  const session = await getSession([agentName]);

  await session.addMessages([
    agentPeer.message(content, {
      metadata: { type: "conclusion", source: "dex" },
    }),
  ]);
}
