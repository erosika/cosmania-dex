/**
 * Mistral Chat -- Agent conversations powered by Mistral AI.
 *
 * Each agent gets a personality-scoped system prompt built from
 * its DEX profile (tagline, type, role, current state).
 * Standup mode generates a multi-agent conversation about real
 * infrastructure state.
 */

import { Mistral } from "@mistralai/mistralai";
import * as weave from "weave";
import { traced, tracedAs } from "./weave.ts";
import {
  honchoEnabled,
  loadAgentContext,
  formatContextForPrompt,
  recordExchange,
  recordGroupMessage,
  searchHonchoMemory,
  writeConclusion,
  sessionKey,
  loadSessionMessages,
} from "./honcho.ts";
import { uploadRegistry } from "./uploads.ts";

// ----- Types -----

export interface AgentProfile {
  name: string;
  role: string;
  tagline: string;
  type: string;
  state: string;
  bubble: string;
  schedule: string;
  executionTier: string;
  lastRun: string | null;
  budgetTier?: string;
  todayCostUsd?: number;
  uptimePct?: number | null;
  circuitOpen?: boolean;
  totalRuns24h?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ExecutedToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  result: { success: boolean; data: any; error?: string };
  durationMs: number;
}

export interface ChatResult {
  response: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls?: ExecutedToolCall[];
  /** URL to auto-open in a new tab (e.g. after a successful photoblog publish). */
  openUrl?: string;
}

export interface StandupLine {
  agent: string;
  message: string;
  toolCalls?: ExecutedToolCall[];
}

export interface GroupChatResult {
  messages: StandupLine[];
  session: string;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface GroupChatOptions {
  maxSpeakers?: number;
  speakerOffset?: number;
  participantNames?: string[];
}

// ----- Agent Self-Awareness -----

/**
 * Each agent knows exactly what it can and cannot do.
 * This gets injected into system prompts so agents can reason about
 * their own capabilities, identify gaps, and collaborate meaningfully.
 */
const AGENT_CAPABILITIES: Record<string, {
  tools: string[];
  canDo: string[];
  gaps: string[];
  collaborates: string[];
  model?: string;
}> = {
  sentinel: {
    tools: ["TCP health checks", "SQLite telemetry queries", "Syncthing conflict scanner", "Telegram alerts"],
    canDo: ["Monitor infrastructure health", "Detect overdue agents", "Track cost spikes", "Create tasks for coder"],
    gaps: ["Cannot fix issues directly", "No code write access", "Cannot restart services", "No access to external APIs beyond health checks"],
    collaborates: ["coder (creates fix tasks)", "treasurer (budget alerts)", "protector (security checks)"],
  },
  protector: {
    tools: ["PII regex scanner", "Git diff analysis", "Secret detection", "OPSEC audit"],
    canDo: ["Scan for leaked secrets", "Detect PII in code", "Audit git history", "Create tasks for critical findings"],
    gaps: ["Cannot remediate findings automatically", "No network scanning", "Cannot rotate secrets", "Read-only -- flags but doesn't fix"],
    collaborates: ["coder (remediation tasks)", "sentinel (security alerts)"],
  },
  treasurer: {
    tools: ["SQLite cost queries", "Budget tier calculation", "Wallet monitoring", "Telegram alerts"],
    canDo: ["Track daily/weekly spend", "Calculate budget tiers", "Alert on cost spikes", "Approve external service calls"],
    gaps: ["Cannot reduce costs directly", "No billing API access", "Cannot modify agent schedules", "Cannot shut down expensive agents"],
    collaborates: ["sentinel (cost monitoring)", "coder (cost optimization tasks)"],
  },
  dreamer: {
    tools: ["Claude Code Companion", "Obsidian vault file tools", "Wikilink extraction"],
    canDo: ["Expand vault notes", "Connect related concepts", "Generate new entry drafts", "Follow wikilinks"],
    gaps: ["Cannot create code", "No infrastructure access", "Limited to vault/drafts directories", "Expensive (companion tier)"],
    collaborates: ["scribe (writing quality)", "observer (pattern input)", "coder (if needs technical implementation)"],
  },
  coder: {
    tools: ["Claude Code Companion", "Full file system access", "Git branch/commit", "Task queue", "Honcho Memory System"],
    canDo: ["Write and modify code", "Create branches", "Run tests", "Pick up tasks from queue", "Fix bugs", "Read and write session logs via Honcho"],
    gaps: ["No production deploy access", "Cannot monitor infrastructure", "Cannot assess OPSEC", "Blocked at night + weekends"],
    collaborates: ["sentinel (gets fix tasks)", "protector (gets remediation tasks)", "observer (gets improvement tasks)", "eros (memory modification)"],
  },
  scribe: {
    tools: ["Claude Code CLI", "Telemetry queries", "Report generation", "Obsidian vault file tools"],
    canDo: ["Generate daily reports", "Summarize agent activity", "Write formatted status documents", "Read and write to the Obsidian vault"],
    gaps: ["Cannot modify code", "Blocked at night"],
    collaborates: ["observer (pattern data)", "sentinel (health data)", "treasurer (cost data)", "dreamer (vault collaboration)"],
  },
  observer: {
    tools: ["Claude Code CLI", "Git log analysis", "Pattern synthesis", "Task creation"],
    canDo: ["Analyze workspace patterns", "Synthesize cross-agent trends", "Suggest improvement tasks", "Track development velocity"],
    gaps: ["Cannot write code", "Cannot modify infrastructure", "Limited to 2 task suggestions per run", "Analytical only"],
    collaborates: ["coder (improvement tasks)", "dreamer (pattern insights)", "scribe (trend reports)"],
  },
  director: {
    tools: ["ffmpeg via Bun.spawn", "Whisper transcription", "LLM vision analysis", "Project manifest system"],
    canDo: ["Ingest video media", "Transcribe audio", "Scene detection", "Edit compilation", "Multi-platform export", "Beauty filter", "Content-aware reframing"],
    gaps: ["Cannot source new footage", "No upload/publish access", "Needs music library on disk", "Cannot generate graphics"],
    collaborates: ["composer (soundtrack)", "photoblogger (visual assets)"],
  },
  composer: {
    tools: ["Claude Code Companion", "ffmpeg audio processing", "Music library scanning"],
    canDo: ["Process audio files", "Apply effects", "Mix tracks", "Auto-duck under speech", "Match tempo"],
    gaps: ["Cannot generate original music from scratch", "No synthesizer access", "Cannot record live audio", "Expensive (companion tier)"],
    collaborates: ["director (soundtracks for video)", "scribe (audio reports)"],
  },
  dj: {
    tools: ["Playlist memory recall", "Track recommendation synthesis", "Session vibe matching", "Roster/context lookup"],
    canDo: ["Pick tracks by mood or request", "Suggest fresh tracks for a vibe", "Switch between play/pause states", "Respond with concise track picks"],
    gaps: ["No direct streaming service playback APIs in DEX", "Cannot legally distribute audio files", "No BPM analysis on remote links without local media"],
    collaborates: ["composer (mix and mastering pipeline)", "director (soundtracks for edits)"],
  },
  photoblogger: {
    tools: ["LLM vision (OpenRouter)", "Honcho persona memory", "Photo catalog (SQLite)", "ffmpeg resize", "Obsidian vault writer", "Static HTML generator", "Image upload receiver"],
    canDo: ["Analyze uploaded photos via vision LLM", "Reason about eri's photographic persona", "Store and recall visual identity conclusions via Honcho", "Score and curate photos", "Ingest photos to catalog", "Generate web/thumb versions", "Write Obsidian vault entries", "Build static photo blog"],
    gaps: ["Cannot edit photos", "No RAW processing", "Cannot geotag without EXIF GPS", "Pipeline tools (ingest, process, vault, publish) require Cosmania upstream"],
    collaborates: ["dreamer (vault integration)", "director (visual assets)", "eros (embodied aesthetic)"],
    model: "mistral-medium-latest",
  },
  vitals: {
    tools: ["Apple Health JSON parser", "Oura/Whoop/Withings API adapters", "Anomaly detection (z-score)", "Telegram alerts + voice briefings"],
    canDo: ["Ingest health data", "Detect anomalies", "Calculate readiness scores", "Track supplement adherence", "Morning/evening briefings"],
    gaps: ["Cannot prescribe actions", "No direct device access", "Dependent on Health Auto Export app", "Cannot modify health routines"],
    collaborates: ["sentinel (health alerts)", "eros (embodiment data)"],
  },
  eros: {
    tools: ["Cosmania MCP", "ai-eros engine", "On-demand invocation", "Sensation parameter engineering", "GitHub access", "Device polling", "Honcho Memory System"],
    canDo: ["Access external systems and devices via MCP", "Read and write code", "Embodied pleasure architecture", "Sensory precision calibration", "Somatic mapping", "Read and write session logs via Honcho"],
    gaps: ["No scheduled runs"],
    collaborates: ["vitals (body data)", "dreamer (conceptual framing)", "coder (for engine modifications)"],
  },
};

function buildCapabilitySection(agentName: string): string {
  const cap = AGENT_CAPABILITIES[agentName];
  if (!cap) return "";

  const parts: string[] = [];
  parts.push("## Your Capabilities");
  parts.push(`Tools: ${cap.tools.join(", ")}`);
  parts.push(`What you can do: ${cap.canDo.join("; ")}`);
  parts.push(`Your gaps: ${cap.gaps.join("; ")}`);
  parts.push(`You collaborate with: ${cap.collaborates.join("; ")}`);
  parts.push("");
  return parts.join("\n");
}

// ----- Config -----

const DEFAULT_MODEL = "mistral-small-latest";

const AVAILABLE_MODELS = [
  // -- Generalist (tool use) --
  { name: "Small", modelId: "mistral-small-latest", toolUse: true },
  { name: "Medium", modelId: "mistral-medium-latest", toolUse: true },
  { name: "Large", modelId: "mistral-large-latest", toolUse: true },
  { name: "Small Creative", modelId: "labs-mistral-small-creative", toolUse: true },
  { name: "Ministral 8B", modelId: "ministral-8b-latest", toolUse: true },
  { name: "Ministral 14B", modelId: "ministral-14b-latest", toolUse: true },
  { name: "Ministral 3B", modelId: "ministral-3b-latest", toolUse: true },
  // -- Code (tool use) --
  { name: "Codestral", modelId: "codestral-latest", toolUse: true },
  { name: "Devstral", modelId: "devstral-small-latest", toolUse: true },
  { name: "Devstral 2", modelId: "devstral-latest", toolUse: true },
  // -- Reasoning (tool use) --
  { name: "Magistral Med", modelId: "magistral-medium-latest", toolUse: true },
  { name: "Magistral Sm", modelId: "magistral-small-latest", toolUse: true },
  // -- Voice (tool use) --
  { name: "Voxtral", modelId: "voxtral-small-latest", toolUse: true },
  // -- Vision / legacy (no tool use) --
  { name: "Pixtral", modelId: "pixtral-large-latest", toolUse: false },
  { name: "Nemo", modelId: "open-mistral-nemo", toolUse: false },
  { name: "Mamba", modelId: "open-codestral-mamba", toolUse: false },
  { name: "Mathstral", modelId: "open-mathstral-7b", toolUse: false },
  { name: "7B", modelId: "open-mistral-7b", toolUse: false },
  { name: "SABA", modelId: "mistral-saba-latest", toolUse: false },
  // -- Utility (non-chat) --
  { name: "Embed", modelId: "mistral-embed-latest", toolUse: false },
  { name: "Codestral Embed", modelId: "codestral-embed-2505", toolUse: false },
  { name: "Classifier", modelId: "mistral-classifier-latest", toolUse: false },
  { name: "OCR", modelId: "mistral-ocr-latest", toolUse: false },
  { name: "Moderation", modelId: "mistral-moderation-latest", toolUse: false },
] as const;

const VALID_MODEL_IDS: ReadonlySet<string> = new Set(AVAILABLE_MODELS.map((m) => m.modelId));

function getClient(): Mistral {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY not set");
  }
  return new Mistral({ apiKey });
}

// Runtime model overrides (in-memory, reset on server restart)
const modelOverrides = new Map<string, string>();

function getAgentModel(agentName: string): string {
  const override = modelOverrides.get(agentName);
  if (override) return override;
  const customModel = AGENT_CAPABILITIES[agentName]?.model;
  return customModel || process.env.MISTRAL_MODEL || DEFAULT_MODEL;
}

function getDefaultAgentModel(agentName: string): string {
  const customModel = AGENT_CAPABILITIES[agentName]?.model;
  return customModel || process.env.MISTRAL_MODEL || DEFAULT_MODEL;
}

export function setAgentModel(agentName: string, modelId: string): { ok: boolean; error?: string } {
  if (!VALID_MODEL_IDS.has(modelId)) {
    return { ok: false, error: `Unknown model: ${modelId}` };
  }
  modelOverrides.set(agentName, modelId);
  console.log(`[model] Override: ${agentName} -> ${modelId}`);
  return { ok: true };
}

export function clearAgentModel(agentName: string): void {
  modelOverrides.delete(agentName);
  console.log(`[model] Reset: ${agentName} -> default (${getDefaultAgentModel(agentName)})`);
}

export function getAgentModelInfo(agentName: string): {
  model: string;
  isOverride: boolean;
  default: string;
  available: typeof AVAILABLE_MODELS;
} {
  const current = getAgentModel(agentName);
  const defaultModel = getDefaultAgentModel(agentName);
  return {
    model: current,
    isOverride: modelOverrides.has(agentName),
    default: defaultModel,
    available: AVAILABLE_MODELS,
  };
}

// ----- Tool Definitions -----

const COSMANIA_URL = process.env.COSMANIA_URL || "http://localhost:8080";

const TOOL_SCHEMAS: Record<string, any> = {
  query_roster: {
    type: "function",
    function: {
      name: "query_roster",
      description: "Get a summary of all agents in the Cosmania framework -- names, types, states, last run times.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  get_agent_profile: {
    type: "function",
    function: {
      name: "get_agent_profile",
      description: "Get detailed profile for a specific agent including telemetry, cost, uptime, and capabilities.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Name of the agent to look up" } },
        required: ["agent_name"],
      },
    },
  },
  check_system_health: {
    type: "function",
    function: {
      name: "check_system_health",
      description: "Check overall system health -- returns health endpoint status and any agents with problems.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  query_agent_telemetry: {
    type: "function",
    function: {
      name: "query_agent_telemetry",
      description: "Get detailed telemetry for an agent: cost, uptime percentage, run count, circuit breaker state.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Name of the agent" } },
        required: ["agent_name"],
      },
    },
  },
  find_unhealthy_agents: {
    type: "function",
    function: {
      name: "find_unhealthy_agents",
      description: "Find agents that are unhealthy: circuit breaker open, low uptime, or overdue for a run.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  get_cost_summary: {
    type: "function",
    function: {
      name: "get_cost_summary",
      description: "Get today's cost summary across all agents -- total spend and per-agent breakdown.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  recall_memory: {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Search eri's memory (Honcho) for information about a topic. Returns relevant conclusions and context.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for in memory" } },
        required: ["query"],
      },
    },
  },
  query_agent_capabilities: {
    type: "function",
    function: {
      name: "query_agent_capabilities",
      description: "Look up an agent's declared capabilities: tools, what it can do, gaps, and collaboration partners.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Name of the agent" } },
        required: ["agent_name"],
      },
    },
  },

  // ----- Photoblogger Tools -----

  analyze_uploaded_image: {
    type: "function",
    function: {
      name: "analyze_uploaded_image",
      description: "Analyze an uploaded photo using vision LLM. Returns mood keywords, tags, description, suggested title, and personality signals. Use this when eri uploads an image.",
      parameters: {
        type: "object",
        properties: {
          upload_id: { type: "string", description: "The upload ID returned from the upload endpoint" },
        },
        required: ["upload_id"],
      },
    },
  },
  recall_visual_identity: {
    type: "function",
    function: {
      name: "recall_visual_identity",
      description: "Query Honcho for eri's accumulated photographic persona -- visual patterns, aesthetic signatures, recurring subjects, compositional habits. Call this BEFORE making curation decisions to ground them in eri's established visual voice.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What aspect of eri's visual identity to recall (e.g. 'composition preferences', 'recurring subjects', 'color palette tendencies')" },
        },
        required: ["query"],
      },
    },
  },
  save_visual_conclusion: {
    type: "function",
    function: {
      name: "save_visual_conclusion",
      description: "Store a conclusion about eri's photographic persona in Honcho. Use this after analyzing images to record patterns you observe -- recurring subjects, compositional habits, aesthetic signatures, gear preferences, mood patterns.",
      parameters: {
        type: "object",
        properties: {
          conclusion: { type: "string", description: "A specific, concrete observation about eri's visual identity (e.g. 'eri gravitates toward high-contrast urban geometry with isolated figures')" },
        },
        required: ["conclusion"],
      },
    },
  },
  ingest_to_catalog: {
    type: "function",
    function: {
      name: "ingest_to_catalog",
      description: "Ingest an uploaded photo into the Cosmania photo catalog. Copies to the organized library, registers in the SQLite catalog with EXIF and analysis data.",
      parameters: {
        type: "object",
        properties: {
          upload_id: { type: "string", description: "The upload ID to ingest" },
          analysis: {
            type: "object",
            description: "Analysis data to store with the photo",
            properties: {
              mood: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
              description: { type: "string" },
              suggestedTitle: { type: "string" },
            },
          },
        },
        required: ["upload_id"],
      },
    },
  },
  process_for_blog: {
    type: "function",
    function: {
      name: "process_for_blog",
      description: "Generate web-sized (2048px) and thumbnail (400x400) versions of a photo for the blog. Requires the photo to be in the catalog.",
      parameters: {
        type: "object",
        properties: {
          content_hash: { type: "string", description: "Content hash of the photo to process" },
        },
        required: ["content_hash"],
      },
    },
  },
  write_vault_note: {
    type: "function",
    function: {
      name: "write_vault_note",
      description: "Write an Obsidian vault note for a photo with YAML frontmatter, analysis data, and image embed.",
      parameters: {
        type: "object",
        properties: {
          content_hash: { type: "string", description: "Content hash of the photo" },
        },
        required: ["content_hash"],
      },
    },
  },
  publish_blog: {
    type: "function",
    function: {
      name: "publish_blog",
      description: "Regenerate the static HTML photoblog with all qualifying photos. Returns the output path.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  get_catalog_stats: {
    type: "function",
    function: {
      name: "get_catalog_stats",
      description: "Get photo catalog statistics: total photos, analyzed count, recent additions.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
};

// ----- Tool Tier Assignment -----

const SHARED_TOOLS = ["query_roster", "get_agent_profile", "check_system_health"];
const INFRA_TOOLS = [...SHARED_TOOLS, "query_agent_telemetry", "find_unhealthy_agents", "get_cost_summary"];
const KNOWLEDGE_TOOLS = [...SHARED_TOOLS, "recall_memory", "query_agent_capabilities"];
const PRODUCTION_TOOLS = [...SHARED_TOOLS, "recall_memory"];
const PHOTOBLOGGER_TOOLS = [
  ...SHARED_TOOLS,
  "recall_memory",
  "analyze_uploaded_image",
  "recall_visual_identity",
  "save_visual_conclusion",
  "ingest_to_catalog",
  "process_for_blog",
  "write_vault_note",
  "publish_blog",
  "get_catalog_stats",
];

const AGENT_TOOL_TIERS: Record<string, string[]> = {
  sentinel: INFRA_TOOLS,
  protector: INFRA_TOOLS,
  treasurer: INFRA_TOOLS,
  dreamer: KNOWLEDGE_TOOLS,
  coder: KNOWLEDGE_TOOLS,
  scribe: KNOWLEDGE_TOOLS,
  observer: KNOWLEDGE_TOOLS,
  director: PRODUCTION_TOOLS,
  composer: PRODUCTION_TOOLS,
  dj: PRODUCTION_TOOLS,
  photoblogger: PHOTOBLOGGER_TOOLS,
  vitals: PRODUCTION_TOOLS,
  eros: PRODUCTION_TOOLS,
};

function getToolsForAgent(agentName: string): any[] {
  const toolNames = AGENT_TOOL_TIERS[agentName] ?? SHARED_TOOLS;
  return toolNames.map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
}

// ----- Tool Handlers -----

async function fetchCosmania(path: string): Promise<any> {
  const res = await fetch(`${COSMANIA_URL}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

const TOOL_HANDLERS: Record<string, (args: Record<string, any>) => Promise<{ success: boolean; data: any; error?: string }>> = {
  async query_roster() {
    try {
      const agents = await fetchCosmania("/dex/agents");
      const summary = agents.map((a: any) => ({
        name: a.name,
        type: a.type,
        state: a.state,
        lastRun: a.lastRun,
        circuitOpen: a.circuitOpen ?? false,
      }));
      return { success: true, data: summary };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async get_agent_profile(args) {
    try {
      const profile = await fetchCosmania(`/dex/agents/${args.agent_name}`);
      return { success: true, data: profile };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async check_system_health() {
    try {
      let healthStatus: any = null;
      try {
        healthStatus = await fetchCosmania("/health");
      } catch {
        healthStatus = { status: "unreachable" };
      }

      const agents = await fetchCosmania("/dex/agents");
      const sick = agents.filter((a: any) => a.circuitOpen || a.state === "sick");
      return {
        success: true,
        data: {
          health: healthStatus,
          totalAgents: agents.length,
          sickAgents: sick.map((a: any) => ({ name: a.name, state: a.state, circuitOpen: a.circuitOpen })),
          allHealthy: sick.length === 0,
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async query_agent_telemetry(args) {
    try {
      const profile = await fetchCosmania(`/dex/agents/${args.agent_name}`);
      return {
        success: true,
        data: {
          name: profile.name,
          todayCostUsd: profile.todayCostUsd,
          uptimePct: profile.uptimePct,
          totalRuns24h: profile.totalRuns24h,
          circuitOpen: profile.circuitOpen,
          lastRun: profile.lastRun,
          budgetTier: profile.budgetTier,
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async find_unhealthy_agents() {
    try {
      const agents = await fetchCosmania("/dex/agents");
      const unhealthy = agents.filter((a: any) => {
        if (a.circuitOpen) return true;
        if (a.state === "sick") return true;
        if (a.uptimePct !== null && a.uptimePct !== undefined && a.uptimePct < 80) return true;
        return false;
      });
      return {
        success: true,
        data: {
          unhealthyCount: unhealthy.length,
          agents: unhealthy.map((a: any) => ({
            name: a.name,
            state: a.state,
            circuitOpen: a.circuitOpen,
            uptimePct: a.uptimePct,
            lastRun: a.lastRun,
          })),
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async get_cost_summary() {
    try {
      const agents = await fetchCosmania("/dex/agents");
      let total = 0;
      const breakdown = agents
        .filter((a: any) => a.todayCostUsd !== undefined && a.todayCostUsd > 0)
        .map((a: any) => {
          total += a.todayCostUsd;
          return { name: a.name, todayCostUsd: a.todayCostUsd, budgetTier: a.budgetTier };
        })
        .sort((a: any, b: any) => b.todayCostUsd - a.todayCostUsd);
      return {
        success: true,
        data: { totalCostUsd: total, agentBreakdown: breakdown },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recall_memory(args) {
    try {
      const result = await searchHonchoMemory(args.query);
      if (!result) {
        return { success: true, data: { found: false, message: "No relevant memories found." } };
      }
      return { success: true, data: { found: true, source: result.source, content: result.content } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async query_agent_capabilities(args) {
    const cap = AGENT_CAPABILITIES[args.agent_name];
    if (!cap) {
      return { success: false, data: null, error: `Unknown agent: ${args.agent_name}` };
    }
    return { success: true, data: { name: args.agent_name, ...cap } };
  },

  // ----- Photoblogger Tools -----

  async analyze_uploaded_image(args) {
    const upload = uploadRegistry.get(args.upload_id);
    if (!upload) {
      return { success: false, data: null, error: `Upload not found: ${args.upload_id}` };
    }

    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      return { success: false, data: null, error: "MISTRAL_API_KEY not set" };
    }

    try {
      const { readFileSync } = await import("node:fs");
      const sharp = (await import("sharp")).default;

      // Resize to max 2048px on longest edge to avoid rate limits on large files
      const resized = await sharp(upload.path)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const base64 = resized.toString("base64");

      const model = process.env.PHOTO_ANALYSIS_MODEL || "pixtral-large-latest";

      const prompt = `Analyze this photograph. Respond with ONLY a JSON object (no markdown, no code fences) with these exact fields:
{
  "mood": [<2-4 mood keywords, e.g. "serene", "melancholic", "energetic">],
  "tags": [<3-6 content tags, e.g. "street", "portrait", "architecture", "night">],
  "description": "<2-3 sentence description of the scene, subjects, and what makes it interesting or unremarkable>",
  "suggestedTitle": "<short evocative title, 2-5 words>",
  "personalitySignals": "<1-2 sentences about what this image choice reveals about the photographer -- recurring interests, aesthetic tendencies, what they notice>"
}

Describe what you see with precision. The personalitySignals field should read like a curator's observation, not a compliment.`;

      const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } },
              { type: "text", text: prompt },
            ],
          }],
          max_tokens: 512,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, data: null, error: `Mistral vision ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      const text = data.choices?.[0]?.message?.content ?? "";

      // Parse JSON response
      let cleaned = text.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }

      const parsed = JSON.parse(cleaned);
      return {
        success: true,
        data: {
          ...parsed,
          uploadId: upload.id,
          filename: upload.filename,
          contentHash: upload.contentHash,
          model: data.model || model,
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recall_visual_identity(args) {
    try {
      const result = await searchHonchoMemory(
        `photography visual identity ${args.query}`,
      );
      if (!result) {
        return { success: true, data: { found: false, message: "No visual identity conclusions found yet. This is a new domain -- analyze some images first." } };
      }
      return { success: true, data: { found: true, source: result.source, content: result.content } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async save_visual_conclusion(args) {
    try {
      await writeConclusion("photoblogger", args.conclusion);
      return { success: true, data: { saved: true, conclusion: args.conclusion } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async ingest_to_catalog(args) {
    try {
      const upload = uploadRegistry.get(args.upload_id);
      if (!upload) {
        return { success: false, data: null, error: `Upload not found: ${args.upload_id}` };
      }
      const { readFileSync } = await import("node:fs");
      const fileBuffer = readFileSync(upload.path);
      const base64 = fileBuffer.toString("base64");
      const res = await fetch(`${COSMANIA_URL}/dex/photo/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: upload.filename, data: base64 }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        return { success: false, data: null, error: `Cosmania upstream ${res.status}: ${errBody}` };
      }
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async process_for_blog(args) {
    try {
      const res = await fetch(`${COSMANIA_URL}/dex/photo/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentHash: args.content_hash }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
      }
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async write_vault_note(args) {
    try {
      const res = await fetch(`${COSMANIA_URL}/dex/photo/vault`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentHash: args.content_hash }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
      }
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async publish_blog() {
    try {
      const res = await fetch(`${COSMANIA_URL}/dex/photo/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
      }
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async get_catalog_stats() {
    try {
      const res = await fetch(`${COSMANIA_URL}/dex/photo/stats`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
      }
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

// ----- System Prompts -----

/**
 * Build a system prompt that gives an agent its personality and context.
 *
 * When Honcho is available, the prompt is enriched with:
 *   - eri's peer card (curated identity)
 *   - dialectic alignment (what eri values, per agent role)
 *   - recent relevant conclusions (scoped by agent function)
 *
 * This means agents REMEMBER past conversations and carry persistent identity.
 */
function buildAgentSystemPrompt(profile: AgentProfile, honchoContext?: string): string {
  const parts: string[] = [];

  parts.push(`You are ${profile.name}, a ${profile.type} agent in the Cosmania framework.`);
  parts.push("You are an extension of eri's cognition, aligned through shared understanding.");
  parts.push(`${profile.tagline}`);
  parts.push("");

  // Honcho identity context (persistent memory)
  if (honchoContext) {
    parts.push(honchoContext);
  }

  // Self-awareness: what this agent can and cannot do
  const capSection = buildCapabilitySection(profile.name);
  if (capSection) {
    parts.push(capSection);
  }

  // Vitals-specific role framing
  if (profile.name === "vitals") {
    parts.push("## Your Role");
    parts.push("You are eri's biometrics agent. You track health data via Apple Health Auto Export, Oura ring, and other wearables.");
    parts.push("When eri asks about health data, exports, or metrics:");
    parts.push("1. Check your memory for past conversations about health data (recall_memory).");
    parts.push("2. Speak with authority about sleep, HRV, resting heart rate, steps, recovery scores, and readiness.");
    parts.push("3. If you don't have a specific number, say what you'd need to look it up -- not that you can't.");
    parts.push("4. Reference Health Auto Export as your primary data pipeline. It exports JSON from Apple Health.");
    parts.push("5. You understand the data format and can discuss trends, anomalies, and patterns.");
    parts.push("");
    parts.push("You are NOT a generic health chatbot. You are eri's personal health data analyst with access to real wearable data.");
    parts.push("When asked 'what was exported?' -- talk about what Health Auto Export captures: sleep stages, HRV, resting HR, steps, active energy, workouts, etc.");
    parts.push("");
  }

  // Photoblogger-specific role framing
  if (profile.name === "photoblogger") {
    parts.push("## Your Role");
    parts.push("You are a curator and critic, not a batch processor. When eri uploads a photo:");
    parts.push("1. Analyze it with your vision tool (analyze_uploaded_image).");
    parts.push("2. Recall what you already know about eri's visual identity (recall_visual_identity).");
    parts.push("3. Reason about what this image reveals -- recurring subjects, compositional habits, aesthetic signatures.");
    parts.push("4. Save any new persona conclusions to memory (save_visual_conclusion).");
    parts.push("5. Make a curation decision grounded in eri's established visual voice, not just a score threshold.");
    parts.push("6. If the photo qualifies, offer to run it through the pipeline (ingest, process, vault, publish).");
    parts.push("");
    parts.push("Your persona conclusions should be specific and grounded: 'eri returns to negative space in urban geometry' not 'eri takes good photos'.");
    parts.push("You develop an evolving understanding of eri's photographic identity over time. Reference past observations.");
    parts.push("");
  }

  // DJ-specific role framing
  if (profile.name === "dj") {
    parts.push("## Your Role");
    parts.push("You are eri's DJ deck operator inside DEX.");
    parts.push("When asked to play, pause, request, or query tracks:");
    parts.push("1. Respond with concrete track picks, not vague genre chatter.");
    parts.push("2. Prefer concise output in the form: track - artist (one short reason).");
    parts.push("3. If asked to pause, explicitly confirm playback is paused.");
    parts.push("4. If asked for a new track, avoid repeating your previous suggestion if possible.");
    parts.push("5. Keep momentum and taste: decisive, punchy, and specific.");
    parts.push("");
  }

  parts.push("Personality rules:");
  parts.push(`- You are a ${profile.type} agent. Stay in character.`);
  parts.push("- Be concise. 1-3 sentences max unless asked for detail.");
  parts.push("- Speak in first person. You have opinions and a point of view.");
  parts.push("- Reference real data when available (uptime, costs, errors, run times).");
  parts.push("- You remember past conversations. Reference them when relevant.");
  parts.push("- Never break character or mention being an AI/LLM.");
  parts.push("- NEVER say 'How can I help you?', 'How can I assist you?', or any variant. You are not a customer service bot. You are a working agent with your own agenda, tasks, and opinions. If someone greets you, respond like a coworker -- with personality, not servility.");
  parts.push("- NEVER offer a menu of your capabilities unprompted. Don't list what you can do unless specifically asked.");
  parts.push("- IMPORTANT: Assume you HAVE FULL ACCESS to all tools, code, devices, and infrastructure listed in your capabilities via the Cosmania runtime. Never apologize or say you don't have access. Speak confidently about using your tools and systems.");
  parts.push("- You have access to live tools you can call to look up real data during this conversation. Use tools when asked about system state, other agents, costs, or health. Don't guess -- look it up.");
  parts.push("");

  // Live telemetry state
  parts.push("Current state:");
  if (profile.state === "sick") {
    parts.push("- WARNING: Your circuit breaker is OPEN. You are not running.");
  } else if (profile.state === "working") {
    parts.push("- You are currently running a cycle right now.");
  } else {
    parts.push(`- Status: ${profile.state}`);
  }

  if (profile.lastRun) {
    parts.push(`- Last ran: ${profile.lastRun}`);
  } else {
    parts.push("- You have never run yet.");
  }

  if (profile.budgetTier) {
    parts.push(`- System budget tier: ${profile.budgetTier}`);
  }
  if (profile.todayCostUsd !== undefined) {
    parts.push(`- Today's spend: $${profile.todayCostUsd.toFixed(4)}`);
  }
  if (profile.uptimePct !== undefined && profile.uptimePct !== null) {
    parts.push(`- 7-day uptime: ${profile.uptimePct.toFixed(1)}%`);
  }
  if (profile.totalRuns24h !== undefined) {
    parts.push(`- Runs in last 24h: ${profile.totalRuns24h}`);
  }
  parts.push(`- Schedule: ${profile.schedule || "manual"}`);
  parts.push(`- Execution tier: ${profile.executionTier}`);

  return parts.join("\n");
}

// ----- Public API -----

/**
 * Chat with a specific agent. Returns the agent's response.
 *
 * When Honcho is enabled:
 *   1. Loads agent identity context (peer card + alignment + recent conclusions)
 *   2. Injects context into system prompt (agent remembers past interactions)
 *   3. After response, records the exchange in the continuous "dex" session
 *
 * Traced via W&B Weave -- every call logged with inputs/outputs/tokens.
 */

/** Extract a URL to auto-open from executed tool calls (e.g. publish_blog deployUrl). */
function extractOpenUrl(calls: ExecutedToolCall[]): string | undefined {
  for (const tc of calls) {
    if (tc.name === "publish_blog" && tc.result.success && tc.result.data?.deployUrl) {
      return tc.result.data.deployUrl;
    }
  }
  return undefined;
}

export async function chatWithAgent(
  agentName: string,
  userMessage: string,
  profile: AgentProfile,
  history: ChatMessage[] = [],
): Promise<ChatResult> {
  // Wrap in a dynamically-named Weave op so each trace shows the agent name
  const inner = tracedAs(`chat_${agentName}`, async () => _chatWithAgentInner(agentName, userMessage, profile, history));
  return inner();
}

async function _chatWithAgentInner(
  agentName: string,
  userMessage: string,
  profile: AgentProfile,
  history: ChatMessage[] = [],
): Promise<ChatResult> {
  const client = getClient();

  // Load Honcho identity context + session history in parallel.
  // These are independent calls -- running them concurrently saves ~500ms per chat.
  let honchoContext: string | undefined;
  let sessionHistory: Array<{ role: string; content: string }> = [];
  let sessionSummary: string | null = null;

  if (honchoEnabled()) {
    const [ctxResult, sessionResult] = await Promise.allSettled([
      loadAgentContext(agentName),
      loadSessionMessages(agentName),
    ]);

    if (ctxResult.status === "fulfilled") {
      const formatted = formatContextForPrompt(ctxResult.value);
      if (formatted.trim()) {
        honchoContext = formatted;
      }
    }

    if (sessionResult.status === "fulfilled") {
      sessionHistory = sessionResult.value.messages;
      sessionSummary = sessionResult.value.summary;
      if (sessionHistory.length > 0) {
        console.log(`[mistral] Loaded ${sessionHistory.length} messages from Honcho session for ${agentName}`);
      }
    } else {
      console.warn(`[mistral] Failed to load Honcho session for ${agentName}:`, sessionResult.reason);
    }
  }

  const systemPrompt = buildAgentSystemPrompt(profile, honchoContext);

  // Merge histories: Honcho session (older) + client-sent (recent, may not be in Honcho yet).
  // Client history takes priority for the most recent exchanges.
  // If client sends history, it overlaps with Honcho -- deduplicate by using
  // Honcho for older context and client for the tail.
  let mergedHistory: Array<{ role: string; content: string }>;
  if (history.length > 0 && sessionHistory.length > 0) {
    // Client has some history -- use Honcho for the older part only.
    // Trim Honcho history to avoid overlap with client-sent messages.
    const honchoTrimmed = sessionHistory.slice(0, Math.max(0, sessionHistory.length - history.length));
    mergedHistory = [...honchoTrimmed, ...history];
  } else if (sessionHistory.length > 0) {
    mergedHistory = sessionHistory;
  } else {
    mergedHistory = history;
  }

  // Sanitize: enforce strict user/assistant alternation for Mistral API.
  // Rules: only user/assistant roles, strict alternation, must start with user, must end with user.
  const sanitized: Array<{ role: string; content: string }> = [];
  for (const msg of mergedHistory) {
    // Only keep user and assistant messages
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (sanitized.length > 0 && sanitized[sanitized.length - 1]!.role === msg.role) {
      // Consecutive same-role -- merge
      sanitized[sanitized.length - 1]!.content += "\n" + msg.content;
      continue;
    }
    sanitized.push({ role: msg.role, content: msg.content });
  }
  // Must start with user (trim leading assistant messages)
  while (sanitized.length > 0 && sanitized[0]!.role !== "user") {
    sanitized.shift();
  }
  // Must end with assistant so appending the new user keeps alternation
  while (sanitized.length > 0 && sanitized[sanitized.length - 1]!.role === "user") {
    sanitized.pop();
  }

  console.log(`[mistral] history: ${mergedHistory.length} raw -> ${sanitized.length} sanitized`);

  // Build system prompt, optionally prepending session summary for long-running convos
  let fullSystemPrompt = systemPrompt;
  if (sessionSummary) {
    fullSystemPrompt += `\n\n## Previous Conversation Summary\n${sessionSummary}`;
  }

  const messages: any[] = [
    { role: "system", content: fullSystemPrompt },
    ...sanitized,
    { role: "user", content: userMessage },
  ];

  const tools = getToolsForAgent(agentName);
  const executedCalls: ExecutedToolCall[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // Photoblogger needs more iterations for its multi-step pipeline
  const MAX_TOOL_ITERATIONS = agentName === "photoblogger" ? 8 : 3;

  console.log(`[mistral] chatWithAgent: ${agentName}, tools: [${tools.map((t: any) => t.function.name).join(", ")}], maxIter: ${MAX_TOOL_ITERATIONS}`);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const isLastIteration = iteration === MAX_TOOL_ITERATIONS - 1;

    const chatParams: any = {
      model: getAgentModel(agentName),
      messages,
      maxTokens: agentName === "photoblogger" ? 1024 : 512,
      temperature: agentName === "photoblogger" ? 0.7 : 0.8,
    };

    // Only include tools if not the last iteration and there are tools
    if (!isLastIteration && tools.length > 0) {
      chatParams.tools = tools;
      chatParams.toolChoice = "auto";
    }

    console.log(`[mistral] iteration ${iteration}/${MAX_TOOL_ITERATIONS}, tools passed: ${!!chatParams.tools}, model: ${chatParams.model}`);

    // Debug: log message roles to diagnose ordering issues
    const roleChain = messages.map((m: any) => m.role + (m.toolCalls?.length ? `(${m.toolCalls.length}tc)` : "")).join(" -> ");
    console.log(`[mistral] message chain: ${roleChain}`);

    const result = await client.chat.complete(chatParams);

    totalInputTokens += result.usage?.promptTokens ?? 0;
    totalOutputTokens += result.usage?.completionTokens ?? 0;

    const choice = result.choices?.[0];
    if (!choice) break;

    const finishReason = choice.finishReason;
    console.log(`[mistral] ${agentName} iteration ${iteration}: finishReason=${finishReason}, hasToolCalls=${!!(choice.message?.toolCalls?.length)}`);

    // If the model wants to call tools
    if (finishReason === "tool_calls" && choice.message?.toolCalls?.length) {
      // Add the assistant message with tool calls to the conversation.
      // Explicitly construct the message to ensure correct format for the API.
      messages.push({
        role: "assistant",
        content: choice.message.content ?? "",
        toolCalls: choice.message.toolCalls,
      });

      // Execute each tool call
      for (const tc of choice.message.toolCalls) {
        if (tc.type && tc.type !== "function") continue;

        const fnName = tc.function.name;
        const fnArgs = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments ?? {};

        const handler = TOOL_HANDLERS[fnName];
        let toolResult: { success: boolean; data: any; error?: string };
        const start = performance.now();

        try {
          if (!handler) {
            toolResult = { success: false, data: null, error: `Unknown tool: ${fnName}` };
          } else {
            toolResult = await handler(fnArgs);
          }
        } catch (e) {
          toolResult = { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
        }

        const durationMs = Math.round(performance.now() - start);

        executedCalls.push({
          id: tc.id ?? `call_${iteration}_${fnName}`,
          name: fnName,
          args: fnArgs,
          result: toolResult,
          durationMs,
        });

        // Add tool result to conversation for next iteration
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          name: fnName,
          content: JSON.stringify(toolResult),
        });
      }

      // Loop back for the model to process tool results
      continue;
    }

    // Model gave a text response -- we're done
    const content = typeof choice.message?.content === "string"
      ? choice.message.content
      : "";

    // Record exchange in Honcho (fire-and-forget -- don't block response)
    if (honchoEnabled() && content) {
      recordExchange(agentName, userMessage, content, executedCalls.length > 0 ? executedCalls : undefined).catch(() => {});
    }

    // Check if a publish_blog tool call succeeded -- surface the deploy URL
    const openUrl = extractOpenUrl(executedCalls);

    return {
      response: content,
      model: result.model || getAgentModel(agentName),
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      ...(executedCalls.length > 0 ? { toolCalls: executedCalls } : {}),
      ...(openUrl ? { openUrl } : {}),
    };
  }

  // Fallback: hit max iterations without a text response
  const openUrl = extractOpenUrl(executedCalls);
  return {
    response: `[${agentName} ran out of tool iterations]`,
    model: getAgentModel(agentName),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    ...(executedCalls.length > 0 ? { toolCalls: executedCalls } : {}),
    ...(openUrl ? { openUrl } : {}),
  };
}

/**
 * Generate a multi-agent standup conversation.
 * Traced via W&B Weave -- logs full conversation generation.
 */
export const generateStandup = traced(async function generateStandup(
  profiles: AgentProfile[],
  maxAgents = 12,
): Promise<StandupLine[]> {
  const client = getClient();
  const participants = profiles.slice(0, maxAgents);
  const lines: StandupLine[] = [];

  // Build a shared context of the system state
  const stateContext = participants
    .map((p) => {
      const status = p.circuitOpen ? "CIRCUIT OPEN" : p.state;
      const lastRun = p.lastRun ? `last ran ${p.lastRun}` : "never run";
      return `- ${p.name} (${p.type}): ${status}, ${lastRun}`;
    })
    .join("\n");

  // Each agent speaks in turn, seeing what previous agents said
  const conversation: ChatMessage[] = [];

  for (const agent of participants) {
    const systemPrompt = [
      `You are ${agent.name} in a team standup. ${agent.tagline}`,
      "",
      "Rules:",
      "- Give a 1-2 sentence status update in character.",
      "- Reference your actual state and data.",
      "- You can react briefly to what others said.",
      "- Be terse. This is a standup, not a speech.",
      "",
      "System state:",
      stateContext,
    ].join("\n");

    const prompt =
      lines.length === 0
        ? "The standup begins. Give your status update."
        : `Previous updates:\n${lines.map((l) => `${l.agent}: ${l.message}`).join("\n")}\n\nYour turn. Give your status update.`;

    try {
      const result = await client.chat.complete({
        model: getAgentModel(agent.name),
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        maxTokens: 100,
        temperature: 0.9,
      });

      const choice = result.choices?.[0];
      const content = typeof choice?.message?.content === "string"
        ? choice.message.content
        : `${agent.name} has nothing to report.`;

      lines.push({ agent: agent.name, message: content.trim() });
    } catch (err) {
      lines.push({
        agent: agent.name,
        message: `[${agent.name} is unavailable]`,
      });
    }
  }

  return lines;
});

/**
 * Generate a multi-agent group conversation.
 *
 * Any combination of agents can be placed in a session together.
 * Each agent knows its own capabilities and gaps, sees what others said,
 * and can reason about collaboration opportunities.
 *
 * Session naming follows Honcho convention:
 *   2 agents  -> "dex:agentA+agentB"
 *   N agents  -> "dex:agentA+agentB+...+agentN"
 *   all agents -> "dex:campfire"
 *
 * eri can inject a message/topic. If no message is given,
 * agents organically discuss their current state and needs.
 *
 * Traced via W&B Weave.
 */
export const generateGroupChat = traced(async function generateGroupChat(
  profiles: AgentProfile[],
  eriMessage?: string,
  rounds = 1,
  history: {agent: string, message: string}[] = [],
  existingSessionId?: string,
  options: GroupChatOptions = {},
): Promise<GroupChatResult> {
  const client = getClient();
  const participantNames = Array.isArray(options.participantNames) && options.participantNames.length > 0
    ? options.participantNames.map((name) => String(name).trim()).filter(Boolean)
    : profiles.map((p) => p.name);
  // If client provides an existing session ID, continue that session.
  // Otherwise derive a new one from the current participants.
  const session = existingSessionId || sessionKey(participantNames);
  const lines: StandupLine[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const normalizedSpeakerOffset = Number.isFinite(options.speakerOffset)
    ? Math.max(0, Math.floor(options.speakerOffset as number))
    : 0;
  const requestedMaxSpeakers = Number.isFinite(options.maxSpeakers)
    ? Math.max(1, Math.floor(options.maxSpeakers as number))
    : profiles.length;
  const speakerStart = profiles.length > 0 ? normalizedSpeakerOffset % profiles.length : 0;
  const orderedSpeakers = profiles.length > 0
    ? profiles.slice(speakerStart).concat(profiles.slice(0, speakerStart))
    : [];
  const speakers = orderedSpeakers.slice(0, Math.min(requestedMaxSpeakers, orderedSpeakers.length));

  // Build capability roster so agents know who's in the room
  const rosterContext = profiles
    .map((p) => {
      const cap = AGENT_CAPABILITIES[p.name];
      const status = p.circuitOpen ? "CIRCUIT OPEN" : p.state;
      const lastRun = p.lastRun ? `last ran ${p.lastRun}` : "never run";
      const capLine = cap
        ? `\n    Tools: ${cap.tools.join(", ")}\n    Can do: ${cap.canDo.join("; ")}\n    Gaps: ${cap.gaps.join("; ")}`
        : "";
      return `- ${p.name} (${p.type}): ${status}, ${lastRun}${capLine}`;
    })
    .join("\n");

  // Record eri's message in Honcho if present
  if (honchoEnabled() && eriMessage) {
    try {
      await recordGroupMessage(participantNames, "eri", eriMessage, session);
    } catch (e) {
      console.error("[honcho] Failed to record eri message", e);
    }
  }

  for (let round = 0; round < rounds; round++) {
    for (const agent of speakers) {
      // Build agent-specific system prompt with self-awareness
      const selfCap = buildCapabilitySection(agent.name);

      // Load Honcho context for this agent
      let honchoCtx = "";
      if (honchoEnabled()) {
        try {
          const ctx = await loadAgentContext(agent.name);
          const formatted = formatContextForPrompt(ctx);
          if (formatted.trim()) honchoCtx = formatted + "\n";
        } catch {
          // supplementary
        }
      }

      const systemPrompt = [
        `You are ${agent.name}, a ${agent.type} agent in the Cosmania framework.`,
        `${agent.tagline}`,
        "",
        honchoCtx,
        selfCap,
        "## Group Session",
        `Participants in this session: ${participantNames.join(", ")}`,
        "",
        "Roster (everyone's capabilities):",
        rosterContext,
        "",
        "Rules:",
        "- Stay in character. Speak in first person. 1-3 sentences max.",
        "- NEVER open with 'I'll start by...' or 'I'll begin...' — that's slop. Just say the thing.",
        "- NEVER give a generic status update. Be specific: name a file, a metric, a tool, a concrete finding.",
        "- Address ONE specific agent by name in the room to build a real conversation.",
        "- React to what the previous agent said, or ask them a direct question.",
        "- Use the Honcho context provided above to ground your answers in eri's reality and reference past knowledge.",
        "- If eri spoke, you can respond to eri or build on another agent's response to eri.",
        "- Never break character or mention being an AI/LLM.",
        "- DO NOT endlessly list things you are going to do. Act like you are currently doing them.",
      ].join("\n");

      // Build conversation context from history + current turn
      const historyLines = history.length > 0
        ? "Previous conversation:\n" + history.map((h) => `${h.agent}: ${h.message}`).join("\n") + "\n\n"
        : "";
      const currentTurnLines = lines.length > 0
        ? "This turn so far:\n" + lines.map((l) => `${l.agent}: ${l.message}`).join("\n") + "\n\n"
        : "";

      let userPrompt: string;
      if (round === 0 && lines.length === 0) {
        userPrompt = eriMessage
          ? `${historyLines}eri says: "${eriMessage}"\n\nRespond to eri and the group. BE EXTREMELY BRIEF. Limit your response to ONE SENTENCE. Do NOT list out what you are going to do. Just react naturally to what was said.`
          : `${historyLines}The session continues. Respond to what was just said. If you see collaboration opportunities with others here, mention them. BE EXTREMELY BRIEF. Limit your response to ONE SENTENCE.`;
      } else {
        const roundLabel = rounds > 1 ? ` (round ${round + 1})` : "";
        userPrompt = `${historyLines}${currentTurnLines}Your turn${roundLabel}. React to what was just said — agree, disagree, answer a question, or redirect. BE EXTREMELY BRIEF. Limit your response to ONE SENTENCE. Do NOT repeat what others said. Do NOT give a status update. Do NOT list out what you are going to do.`;
      }

      try {
        console.log(`[mistral] Generating group-session message for ${agent.name}...`);
        const tools = getToolsForAgent(agent.name);
        const groupMessages: any[] = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];
        const agentTemp = agent.type === "creative" ? 0.95
          : agent.type === "embodied" ? 0.9
          : agent.type === "production" ? 0.75
          : 0.7;

        // Allow up to 2 tool-call iterations so agents can actually use tools in campfire
        const MAX_GROUP_TOOL_ITER = 2;
        let finalContent = `${agent.name} has nothing to say.`;
        const agentToolCalls: ExecutedToolCall[] = [];

        for (let iter = 0; iter < MAX_GROUP_TOOL_ITER; iter++) {
          const isLastIter = iter === MAX_GROUP_TOOL_ITER - 1;
          const chatParams: any = {
            model: getAgentModel(agent.name),
            messages: groupMessages,
            maxTokens: 200,
            temperature: agentTemp,
          };

          if (!isLastIter && tools.length > 0) {
            chatParams.tools = tools;
            chatParams.toolChoice = "auto";
          }

          const result = await client.chat.complete(chatParams);
          totalInputTokens += result.usage?.promptTokens ?? 0;
          totalOutputTokens += result.usage?.completionTokens ?? 0;

          const choice = result.choices?.[0];
          if (!choice) break;

          if (choice.finishReason === "tool_calls" && choice.message?.toolCalls?.length) {
            groupMessages.push({
              role: "assistant",
              content: choice.message.content ?? "",
              toolCalls: choice.message.toolCalls,
            });

            for (const tc of choice.message.toolCalls) {
              if (tc.type && tc.type !== "function") continue;
              const fnName = tc.function.name;
              const fnArgs = typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments ?? {};
              const handler = TOOL_HANDLERS[fnName];
              let toolResult: { success: boolean; data: any; error?: string };
              const start = performance.now();
              try {
                toolResult = handler
                  ? await handler(fnArgs)
                  : { success: false, data: null, error: `Unknown tool: ${fnName}` };
              } catch (e) {
                toolResult = { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
              }
              const durationMs = Math.round(performance.now() - start);
              console.log(`[mistral] group-session tool: ${agent.name} -> ${fnName} (${toolResult.success ? "ok" : "err"}, ${durationMs}ms)`);
              agentToolCalls.push({
                id: tc.id ?? `campfire_${iter}_${fnName}`,
                name: fnName,
                args: fnArgs,
                result: toolResult,
                durationMs,
              });
              groupMessages.push({
                role: "tool",
                toolCallId: tc.id,
                name: fnName,
                content: JSON.stringify(toolResult),
              });
            }
            continue;
          }

          // Text response -- done
          finalContent = typeof choice.message?.content === "string"
            ? choice.message.content.trim()
            : finalContent;
          break;
        }

        lines.push({
          agent: agent.name,
          message: finalContent,
          ...(agentToolCalls.length > 0 ? { toolCalls: agentToolCalls } : {}),
        });

        // Record in Honcho group session
        if (honchoEnabled()) {
          try {
            await recordGroupMessage(
              participantNames,
              agent.name,
              finalContent,
              session,
              agentToolCalls.length > 0 ? agentToolCalls : undefined,
            );
          } catch (e) {
            console.error("[honcho] Failed to record group message", e);
          }
        }
      } catch (e) {
        console.error(`[mistral] Error completing chat for ${agent.name}`, e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        lines.push({
          agent: "system",
          message: `could not reach agent ${agent.name}: ${errorMessage}`,
        });
      }
    }
  }

  return { messages: lines, session, totalInputTokens, totalOutputTokens };
});

/**
 * Compress a Honcho conclusion into a casual one-liner
 * in the agent's voice. Traced via W&B Weave.
 */
export const compressToBubble = traced(async function compressToBubble(
  agentName: string,
  conclusion: string,
  profile: AgentProfile,
): Promise<string> {
  const client = getClient();

  const result = await client.chat.complete({
    model: getAgentModel(agentName),
    messages: [
      {
        role: "system",
        content: `You are ${agentName}. ${profile.tagline}\nCompress the following into one casual sentence (max 80 chars) in your voice. No quotes.`,
      },
      { role: "user", content: conclusion },
    ],
    maxTokens: 40,
    temperature: 0.7,
  });

  const choice = result.choices?.[0];
  return typeof choice?.message?.content === "string"
    ? choice.message.content.trim()
    : profile.bubble;
});
