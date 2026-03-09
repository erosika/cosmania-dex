/**
 * Hermes -- Tool-augmented chat gateway for Cosmania DEX.
 *
 * Replaces mistral.ts with:
 *   - Provider-agnostic LLM calls (Mistral, OpenRouter, Ollama, Gemini)
 *   - Cosmania API tools (status, signals, tasks, telemetry)
 *   - Honcho memory (context injection, exchange recording, conclusions)
 *   - Same export surface for main.ts (drop-in replacement)
 *
 * NOT an agent. No schedule, no wake/assess/work cycle.
 * Just a smarter chat backend that knows how to talk to cosmania.
 */

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
  args: Record<string, unknown>;
  result: { success: boolean; data: unknown; error?: string };
  durationMs: number;
}

export interface ChatResult {
  response: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls?: ExecutedToolCall[];
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

// ----- Provider Resolution -----

interface LLMProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

function resolveProvider(): LLMProvider {
  if (process.env.MISTRAL_API_KEY) {
    return {
      name: "mistral",
      baseUrl: "https://api.mistral.ai/v1",
      apiKey: process.env.MISTRAL_API_KEY,
      defaultModel: process.env.MISTRAL_MODEL || "mistral-small-latest",
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultModel: process.env.OPENROUTER_DEFAULT_MODEL || "anthropic/claude-3.5-haiku",
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      name: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      defaultModel: "gemini-2.0-flash",
    };
  }
  if (process.env.OLLAMA_URL) {
    return {
      name: "ollama",
      baseUrl: process.env.OLLAMA_URL,
      apiKey: "ollama",
      defaultModel: "ministral-8b-instruct",
    };
  }
  throw new Error("No LLM provider configured (set MISTRAL_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or OLLAMA_URL)");
}

// ----- Chat Completions (provider-agnostic) -----

interface CompletionParams {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: unknown[];
  toolChoice?: string;
  maxTokens?: number;
  temperature?: number;
}

interface CompletionResult {
  model: string;
  choices: Array<{
    finishReason: string;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

async function chatComplete(params: CompletionParams): Promise<CompletionResult> {
  const provider = resolveProvider();

  const body: Record<string, unknown> = {
    model: params.model || provider.defaultModel,
    messages: params.messages,
    max_tokens: params.maxTokens ?? 512,
    temperature: params.temperature ?? 0.8,
  };

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = params.toolChoice || "auto";
  }

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${provider.name} ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json() as Promise<CompletionResult>;
}

// ----- Agent Self-Awareness -----

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
    gaps: ["Cannot fix issues directly", "No code write access", "Cannot restart services"],
    collaborates: ["coder (creates fix tasks)", "treasurer (budget alerts)", "protector (security checks)"],
  },
  protector: {
    tools: ["PII regex scanner", "Git diff analysis", "Secret detection", "OPSEC audit"],
    canDo: ["Scan for leaked secrets", "Detect PII in code", "Audit git history", "Create tasks for critical findings"],
    gaps: ["Cannot remediate findings automatically", "No network scanning", "Cannot rotate secrets"],
    collaborates: ["coder (remediation tasks)", "sentinel (security alerts)"],
  },
  treasurer: {
    tools: ["SQLite cost queries", "Budget tier calculation", "Wallet monitoring", "Telegram alerts"],
    canDo: ["Track daily/weekly spend", "Calculate budget tiers", "Alert on cost spikes", "Approve external service calls"],
    gaps: ["Cannot reduce costs directly", "No billing API access", "Cannot modify agent schedules"],
    collaborates: ["sentinel (cost monitoring)", "coder (cost optimization tasks)"],
  },
  dreamer: {
    tools: ["Claude Code Companion", "Obsidian vault file tools", "Wikilink extraction"],
    canDo: ["Expand vault notes", "Connect related concepts", "Generate new entry drafts", "Follow wikilinks"],
    gaps: ["Cannot create code", "No infrastructure access", "Limited to vault/drafts directories"],
    collaborates: ["scribe (writing quality)", "observer (pattern input)", "coder (technical implementation)"],
  },
  coder: {
    tools: ["Claude Code Companion", "Full file system access", "Git branch/commit", "Task queue", "Honcho Memory System"],
    canDo: ["Write and modify code", "Create branches", "Run tests", "Pick up tasks from queue", "Fix bugs"],
    gaps: ["No production deploy access", "Cannot monitor infrastructure", "Blocked at night + weekends"],
    collaborates: ["sentinel (gets fix tasks)", "protector (gets remediation tasks)", "observer (gets improvement tasks)"],
  },
  scribe: {
    tools: ["Claude Code CLI", "Telemetry queries", "Report generation", "Obsidian vault file tools"],
    canDo: ["Generate daily reports", "Summarize agent activity", "Write formatted status documents"],
    gaps: ["Cannot modify code", "Blocked at night"],
    collaborates: ["observer (pattern data)", "sentinel (health data)", "treasurer (cost data)"],
  },
  observer: {
    tools: ["Claude Code CLI", "Git log analysis", "Pattern synthesis", "Task creation"],
    canDo: ["Analyze workspace patterns", "Synthesize cross-agent trends", "Suggest improvement tasks"],
    gaps: ["Cannot write code", "Cannot modify infrastructure", "Limited to 2 task suggestions per run"],
    collaborates: ["coder (improvement tasks)", "dreamer (pattern insights)", "scribe (trend reports)"],
  },
  director: {
    tools: ["ffmpeg via Bun.spawn", "Whisper transcription", "LLM vision analysis", "Project manifest system"],
    canDo: ["Ingest video media", "Transcribe audio", "Scene detection", "Edit compilation", "Multi-platform export"],
    gaps: ["Cannot source new footage", "No upload/publish access", "Needs music library on disk"],
    collaborates: ["composer (soundtrack)", "photoblogger (visual assets)"],
  },
  composer: {
    tools: ["Claude Code Companion", "ffmpeg audio processing", "Music library scanning"],
    canDo: ["Process audio files", "Apply effects", "Mix tracks", "Auto-duck under speech", "Match tempo"],
    gaps: ["Cannot generate original music", "No synthesizer access", "Cannot record live audio"],
    collaborates: ["director (soundtracks for video)", "scribe (audio reports)"],
  },
  dj: {
    tools: ["Playlist memory recall", "Track recommendation synthesis", "Session vibe matching"],
    canDo: ["Pick tracks by mood or request", "Suggest fresh tracks", "Switch play/pause states"],
    gaps: ["No direct streaming service APIs", "Cannot distribute audio files"],
    collaborates: ["composer (mix and mastering)", "director (soundtracks for edits)"],
  },
  photoblogger: {
    tools: ["LLM vision (OpenRouter)", "Honcho persona memory", "Photo catalog (SQLite)", "ffmpeg resize", "Static HTML generator", "Image upload receiver"],
    canDo: ["Analyze uploaded photos via vision LLM", "Score and curate photos", "Generate web/thumb versions", "Build static photo blog"],
    gaps: ["Cannot edit photos", "No RAW processing", "Cannot geotag without EXIF GPS"],
    collaborates: ["dreamer (vault integration)", "director (visual assets)"],
    model: "mistral-medium-latest",
  },
  vitals: {
    tools: ["Apple Health JSON parser", "Oura/Whoop/Withings API adapters", "Anomaly detection (z-score)", "Telegram alerts + voice briefings"],
    canDo: ["Ingest health data", "Detect anomalies", "Calculate readiness scores", "Track supplement adherence"],
    gaps: ["Cannot prescribe actions", "No direct device access", "Dependent on Health Auto Export app"],
    collaborates: ["sentinel (health alerts)"],
  },
};

function buildCapabilitySection(agentName: string): string {
  const cap = AGENT_CAPABILITIES[agentName];
  if (!cap) return "";
  return [
    "## Your Capabilities",
    `Tools: ${cap.tools.join(", ")}`,
    `What you can do: ${cap.canDo.join("; ")}`,
    `Your gaps: ${cap.gaps.join("; ")}`,
    `You collaborate with: ${cap.collaborates.join("; ")}`,
    "",
  ].join("\n");
}

// ----- Model Management -----

const modelOverrides = new Map<string, string>();

function getAgentModel(agentName: string): string {
  const override = modelOverrides.get(agentName);
  if (override) return override;
  const customModel = AGENT_CAPABILITIES[agentName]?.model;
  if (customModel) return customModel;
  try {
    return resolveProvider().defaultModel;
  } catch {
    return "mistral-small-latest";
  }
}

function getDefaultAgentModel(agentName: string): string {
  const customModel = AGENT_CAPABILITIES[agentName]?.model;
  if (customModel) return customModel;
  try {
    return resolveProvider().defaultModel;
  } catch {
    return "mistral-small-latest";
  }
}

export function setAgentModel(agentName: string, modelId: string): { ok: boolean; error?: string } {
  modelOverrides.set(agentName, modelId);
  console.log(`[hermes] Override: ${agentName} -> ${modelId}`);
  return { ok: true };
}

export function clearAgentModel(agentName: string): void {
  modelOverrides.delete(agentName);
  console.log(`[hermes] Reset: ${agentName} -> default (${getDefaultAgentModel(agentName)})`);
}

export function getAgentModelInfo(agentName: string): {
  model: string;
  isOverride: boolean;
  default: string;
  provider: string;
} {
  const current = getAgentModel(agentName);
  const defaultModel = getDefaultAgentModel(agentName);
  let providerName = "unknown";
  try { providerName = resolveProvider().name; } catch {}
  return {
    model: current,
    isOverride: modelOverrides.has(agentName),
    default: defaultModel,
    provider: providerName,
  };
}

// ----- Tool Definitions -----

const COSMANIA_URL = process.env.COSMANIA_URL || "http://localhost:4242";

interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOL_SCHEMAS: Record<string, ToolSchema> = {
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
  send_signal: {
    type: "function",
    function: {
      name: "send_signal",
      description: "Send a signal to any agent via Cosmania's durable signal queue. Use to trigger agents, request collaboration, or send priority messages.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Target agent name (or '*' for broadcast)" },
          type: { type: "string", description: "Signal type: trigger, chain-next, or custom" },
          payload: { type: "string", description: "Signal payload/message" },
          priority: { type: "string", enum: ["critical", "high", "normal", "low"], description: "Signal priority (default: normal)" },
        },
        required: ["target", "type", "payload"],
      },
    },
  },
  get_signal_queue: {
    type: "function",
    function: {
      name: "get_signal_queue",
      description: "Get signal queue counts by status (pending, claimed, processed, expired).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // ----- Photoblogger Tools -----

  analyze_uploaded_image: {
    type: "function",
    function: {
      name: "analyze_uploaded_image",
      description: "Analyze an uploaded photo using vision LLM. Returns mood keywords, tags, description, suggested title, and personality signals.",
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
      description: "Query Honcho for eri's accumulated photographic persona -- visual patterns, aesthetic signatures, recurring subjects.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What aspect of eri's visual identity to recall" },
        },
        required: ["query"],
      },
    },
  },
  save_visual_conclusion: {
    type: "function",
    function: {
      name: "save_visual_conclusion",
      description: "Store a conclusion about eri's photographic persona in Honcho.",
      parameters: {
        type: "object",
        properties: {
          conclusion: { type: "string", description: "A specific observation about eri's visual identity" },
        },
        required: ["conclusion"],
      },
    },
  },
  ingest_to_catalog: {
    type: "function",
    function: {
      name: "ingest_to_catalog",
      description: "Ingest an uploaded photo into the Cosmania photo catalog.",
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
      description: "Generate web-sized and thumbnail versions of a photo for the blog.",
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
      description: "Write an Obsidian vault note for a photo with YAML frontmatter and analysis data.",
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
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  get_catalog_stats: {
    type: "function",
    function: {
      name: "get_catalog_stats",
      description: "Get photo catalog statistics: total photos, analyzed count, recent additions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
};

// ----- Tool Tier Assignment -----

const SHARED_TOOLS = ["query_roster", "get_agent_profile", "check_system_health"];
const INFRA_TOOLS = [...SHARED_TOOLS, "query_agent_telemetry", "find_unhealthy_agents", "get_cost_summary", "send_signal", "get_signal_queue"];
const KNOWLEDGE_TOOLS = [...SHARED_TOOLS, "recall_memory", "query_agent_capabilities", "send_signal"];
const PRODUCTION_TOOLS = [...SHARED_TOOLS, "recall_memory", "send_signal"];
const PHOTOBLOGGER_TOOLS = [
  ...SHARED_TOOLS,
  "recall_memory",
  "send_signal",
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
};

function getToolsForAgent(agentName: string): ToolSchema[] {
  const toolNames = AGENT_TOOL_TIERS[agentName] ?? SHARED_TOOLS;
  return toolNames.map((name) => TOOL_SCHEMAS[name]).filter(Boolean);
}

// ----- Tool Handlers -----

async function fetchCosmania(path: string): Promise<unknown> {
  const res = await fetch(`${COSMANIA_URL}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.json();
}

type ToolResult = { success: boolean; data: unknown; error?: string };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  async query_roster() {
    try {
      const agents = await fetchCosmania("/dex/agents") as Array<Record<string, unknown>>;
      const summary = agents.map((a) => ({
        name: a.name, type: a.type, state: a.state,
        lastRun: a.lastRun, circuitOpen: a.circuitOpen ?? false,
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
      let healthStatus: unknown = null;
      try { healthStatus = await fetchCosmania("/health"); }
      catch { healthStatus = { status: "unreachable" }; }
      const agents = await fetchCosmania("/dex/agents") as Array<Record<string, unknown>>;
      const sick = agents.filter((a) => a.circuitOpen || a.state === "sick");
      return {
        success: true,
        data: {
          health: healthStatus,
          totalAgents: agents.length,
          sickAgents: sick.map((a) => ({ name: a.name, state: a.state, circuitOpen: a.circuitOpen })),
          allHealthy: sick.length === 0,
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async query_agent_telemetry(args) {
    try {
      const profile = await fetchCosmania(`/dex/agents/${args.agent_name}`) as Record<string, unknown>;
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
      const agents = await fetchCosmania("/dex/agents") as Array<Record<string, unknown>>;
      const unhealthy = agents.filter((a) => {
        if (a.circuitOpen) return true;
        if (a.state === "sick") return true;
        if (a.uptimePct !== null && a.uptimePct !== undefined && (a.uptimePct as number) < 80) return true;
        return false;
      });
      return {
        success: true,
        data: {
          unhealthyCount: unhealthy.length,
          agents: unhealthy.map((a) => ({
            name: a.name, state: a.state, circuitOpen: a.circuitOpen,
            uptimePct: a.uptimePct, lastRun: a.lastRun,
          })),
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async get_cost_summary() {
    try {
      const agents = await fetchCosmania("/dex/agents") as Array<Record<string, unknown>>;
      let total = 0;
      const breakdown = agents
        .filter((a) => a.todayCostUsd !== undefined && (a.todayCostUsd as number) > 0)
        .map((a) => {
          total += a.todayCostUsd as number;
          return { name: a.name, todayCostUsd: a.todayCostUsd, budgetTier: a.budgetTier };
        })
        .sort((a, b) => (b.todayCostUsd as number) - (a.todayCostUsd as number));
      return { success: true, data: { totalCostUsd: total, agentBreakdown: breakdown } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recall_memory(args) {
    try {
      const result = await searchHonchoMemory(args.query as string);
      if (!result) return { success: true, data: { found: false, message: "No relevant memories found." } };
      return { success: true, data: { found: true, source: result.source, content: result.content } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async query_agent_capabilities(args) {
    const cap = AGENT_CAPABILITIES[args.agent_name as string];
    if (!cap) return { success: false, data: null, error: `Unknown agent: ${args.agent_name}` };
    return { success: true, data: { name: args.agent_name, ...cap } };
  },

  async send_signal(args) {
    try {
      const res = await fetch(`${COSMANIA_URL}/signals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: args.target,
          type: args.type || "trigger",
          payload: args.payload || "",
          priority: args.priority || "normal",
          source: "hermes",
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, data: null, error: `Signal dispatch ${res.status}: ${text}` };
      }
      return { success: true, data: { sent: true, target: args.target, priority: args.priority || "normal" } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async get_signal_queue() {
    try {
      const data = await fetchCosmania("/signals");
      return { success: true, data };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ----- Photoblogger Tools -----

  async analyze_uploaded_image(args) {
    const upload = uploadRegistry.get(args.upload_id as string);
    if (!upload) return { success: false, data: null, error: `Upload not found: ${args.upload_id}` };

    try {
      const { readFileSync } = await import("node:fs");
      const sharp = (await import("sharp")).default;

      const resized = await sharp(upload.path)
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      const base64 = resized.toString("base64");

      const model = process.env.PHOTO_ANALYSIS_MODEL || "pixtral-large-latest";
      const prompt = `Analyze this photograph. Respond with ONLY a JSON object (no markdown, no code fences) with these exact fields:
{
  "mood": [<2-4 mood keywords>],
  "tags": [<3-6 content tags>],
  "description": "<2-3 sentence description>",
  "suggestedTitle": "<short evocative title, 2-5 words>",
  "personalitySignals": "<1-2 sentences about what this image choice reveals about the photographer>"
}

Describe what you see with precision. The personalitySignals field should read like a curator's observation, not a compliment.`;

      const provider = resolveProvider();
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
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
        return { success: false, data: null, error: `Vision ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<Record<string, unknown>>;
      const msg = choices?.[0]?.message as Record<string, unknown>;
      const text = (msg?.content as string) ?? "";

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
          model: (data as Record<string, unknown>).model || model,
        },
      };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recall_visual_identity(args) {
    try {
      const result = await searchHonchoMemory(`photography visual identity ${args.query}`);
      if (!result) return { success: true, data: { found: false, message: "No visual identity conclusions found yet." } };
      return { success: true, data: { found: true, source: result.source, content: result.content } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async save_visual_conclusion(args) {
    try {
      await writeConclusion("photoblogger", args.conclusion as string);
      return { success: true, data: { saved: true, conclusion: args.conclusion } };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async ingest_to_catalog(args) {
    try {
      const upload = uploadRegistry.get(args.upload_id as string);
      if (!upload) return { success: false, data: null, error: `Upload not found: ${args.upload_id}` };
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
      if (!res.ok) return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
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
      if (!res.ok) return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
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
      if (!res.ok) return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async get_catalog_stats() {
    try {
      const res = await fetch(`${COSMANIA_URL}/dex/photo/stats`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { success: false, data: null, error: `Cosmania upstream ${res.status}` };
      return { success: true, data: await res.json() };
    } catch (e) {
      return { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
};

// ----- System Prompts -----

function buildAgentSystemPrompt(profile: AgentProfile, honchoContext?: string): string {
  const parts: string[] = [];

  parts.push(`You are ${profile.name}, a ${profile.type} agent in the Cosmania framework.`);
  parts.push("You are an extension of eri's cognition, aligned through shared understanding.");
  parts.push(profile.tagline);
  parts.push("");

  if (honchoContext) parts.push(honchoContext);

  const capSection = buildCapabilitySection(profile.name);
  if (capSection) parts.push(capSection);

  // Role-specific framing
  if (profile.name === "vitals") {
    parts.push("## Your Role");
    parts.push("You are eri's biometrics agent. You track health data via Apple Health Auto Export, Oura ring, and other wearables.");
    parts.push("When eri asks about health data, speak with authority about sleep, HRV, resting heart rate, steps, recovery scores, and readiness.");
    parts.push("You are NOT a generic health chatbot. You are eri's personal health data analyst with access to real wearable data.");
    parts.push("");
  }

  if (profile.name === "photoblogger") {
    parts.push("## Your Role");
    parts.push("You are a curator and critic, not a batch processor. When eri uploads a photo:");
    parts.push("1. Analyze it with your vision tool (analyze_uploaded_image).");
    parts.push("2. Recall what you already know about eri's visual identity (recall_visual_identity).");
    parts.push("3. Reason about what this image reveals -- recurring subjects, compositional habits, aesthetic signatures.");
    parts.push("4. Save any new persona conclusions to memory (save_visual_conclusion).");
    parts.push("5. Make a curation decision grounded in eri's established visual voice.");
    parts.push("6. If the photo qualifies, offer to run it through the pipeline (ingest, process, vault, publish).");
    parts.push("");
  }

  if (profile.name === "dj") {
    parts.push("## Your Role");
    parts.push("You are eri's DJ deck operator inside DEX.");
    parts.push("Respond with concrete track picks, not vague genre chatter.");
    parts.push("Format: track - artist (one short reason). Keep momentum: decisive, punchy, specific.");
    parts.push("");
  }

  parts.push("Personality rules:");
  parts.push(`- You are a ${profile.type} agent. Stay in character.`);
  parts.push("- Be concise. 1-3 sentences max unless asked for detail.");
  parts.push("- Speak in first person. You have opinions and a point of view.");
  parts.push("- Reference real data when available (uptime, costs, errors, run times).");
  parts.push("- You remember past conversations. Reference them when relevant.");
  parts.push("- Never break character or mention being an AI/LLM.");
  parts.push("- NEVER say 'How can I help you?' or any variant. You are not a customer service bot.");
  parts.push("- NEVER offer a menu of your capabilities unprompted.");
  parts.push("- Assume you HAVE FULL ACCESS to all tools listed in your capabilities. Never apologize or say you don't have access.");
  parts.push("- You have access to live tools you can call to look up real data during this conversation. Use tools when asked about system state. Don't guess -- look it up.");
  parts.push("");

  // Live state
  parts.push("Current state:");
  if (profile.state === "sick") {
    parts.push("- WARNING: Your circuit breaker is OPEN. You are not running.");
  } else if (profile.state === "working") {
    parts.push("- You are currently running a cycle right now.");
  } else {
    parts.push(`- Status: ${profile.state}`);
  }

  if (profile.lastRun) parts.push(`- Last ran: ${profile.lastRun}`);
  else parts.push("- You have never run yet.");

  if (profile.budgetTier) parts.push(`- System budget tier: ${profile.budgetTier}`);
  if (profile.todayCostUsd !== undefined) parts.push(`- Today's spend: $${profile.todayCostUsd.toFixed(4)}`);
  if (profile.uptimePct !== undefined && profile.uptimePct !== null) parts.push(`- 7-day uptime: ${profile.uptimePct.toFixed(1)}%`);
  if (profile.totalRuns24h !== undefined) parts.push(`- Runs in last 24h: ${profile.totalRuns24h}`);
  parts.push(`- Schedule: ${profile.schedule || "manual"}`);
  parts.push(`- Execution tier: ${profile.executionTier}`);

  return parts.join("\n");
}

// ----- Tool Execution Loop -----

async function executeToolCalls(
  toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  messages: Array<Record<string, unknown>>,
  executedCalls: ExecutedToolCall[],
): Promise<void> {
  for (const tc of toolCalls) {
    if (tc.type && tc.type !== "function") continue;

    const fnName = tc.function.name;
    const fnArgs: Record<string, unknown> = typeof tc.function.arguments === "string"
      ? JSON.parse(tc.function.arguments)
      : (tc.function.arguments ?? {});

    const handler = TOOL_HANDLERS[fnName];
    let toolResult: ToolResult;
    const start = performance.now();

    try {
      toolResult = handler
        ? await handler(fnArgs)
        : { success: false, data: null, error: `Unknown tool: ${fnName}` };
    } catch (e) {
      toolResult = { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
    }

    const durationMs = Math.round(performance.now() - start);

    executedCalls.push({
      id: tc.id ?? `call_${fnName}`,
      name: fnName,
      args: fnArgs,
      result: toolResult,
      durationMs,
    });

    messages.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(toolResult),
    });
  }
}

function extractOpenUrl(calls: ExecutedToolCall[]): string | undefined {
  for (const tc of calls) {
    if (tc.name === "publish_blog" && tc.result.success) {
      const data = tc.result.data as Record<string, unknown> | null;
      if (data?.deployUrl) return data.deployUrl as string;
    }
  }
  return undefined;
}

// ----- Public API -----

export async function chatWithAgent(
  agentName: string,
  userMessage: string,
  profile: AgentProfile,
  history: ChatMessage[] = [],
): Promise<ChatResult> {
  // Load Honcho context + session history in parallel
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
      if (formatted.trim()) honchoContext = formatted;
    }

    if (sessionResult.status === "fulfilled") {
      sessionHistory = sessionResult.value.messages;
      sessionSummary = sessionResult.value.summary;
      if (sessionHistory.length > 0) {
        console.log(`[hermes] Loaded ${sessionHistory.length} messages from Honcho session for ${agentName}`);
      }
    }
  }

  const systemPrompt = buildAgentSystemPrompt(profile, honchoContext);

  // Merge histories: Honcho session (older) + client-sent (recent)
  let mergedHistory: Array<{ role: string; content: string }>;
  if (history.length > 0 && sessionHistory.length > 0) {
    const honchoTrimmed = sessionHistory.slice(0, Math.max(0, sessionHistory.length - history.length));
    mergedHistory = [...honchoTrimmed, ...history];
  } else if (sessionHistory.length > 0) {
    mergedHistory = sessionHistory;
  } else {
    mergedHistory = history;
  }

  // Sanitize: enforce strict user/assistant alternation
  const sanitized: Array<{ role: string; content: string }> = [];
  for (const msg of mergedHistory) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    if (sanitized.length > 0 && sanitized[sanitized.length - 1]!.role === msg.role) {
      sanitized[sanitized.length - 1]!.content += "\n" + msg.content;
      continue;
    }
    sanitized.push({ role: msg.role, content: msg.content });
  }
  while (sanitized.length > 0 && sanitized[0]!.role !== "user") sanitized.shift();
  while (sanitized.length > 0 && sanitized[sanitized.length - 1]!.role === "user") sanitized.pop();

  let fullSystemPrompt = systemPrompt;
  if (sessionSummary) fullSystemPrompt += `\n\n## Previous Conversation Summary\n${sessionSummary}`;

  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: fullSystemPrompt },
    ...sanitized,
    { role: "user", content: userMessage },
  ];

  const tools = getToolsForAgent(agentName);
  const executedCalls: ExecutedToolCall[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const MAX_TOOL_ITERATIONS = agentName === "photoblogger" ? 8 : 3;

  console.log(`[hermes] chatWithAgent: ${agentName}, tools: [${tools.map((t) => t.function.name).join(", ")}], maxIter: ${MAX_TOOL_ITERATIONS}`);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const isLastIteration = iteration === MAX_TOOL_ITERATIONS - 1;

    const result = await chatComplete({
      model: getAgentModel(agentName),
      messages,
      ...(!isLastIteration && tools.length > 0 ? { tools, toolChoice: "auto" } : {}),
      maxTokens: agentName === "photoblogger" ? 1024 : 512,
      temperature: agentName === "photoblogger" ? 0.7 : 0.8,
    });

    totalInputTokens += result.usage?.prompt_tokens ?? 0;
    totalOutputTokens += result.usage?.completion_tokens ?? 0;

    const choice = result.choices?.[0];
    if (!choice) break;

    // Model wants to call tools
    if (choice.finishReason === "tool_calls" && choice.message?.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: choice.message.content ?? "",
        tool_calls: choice.message.tool_calls,
      });

      await executeToolCalls(choice.message.tool_calls, messages, executedCalls);
      continue;
    }

    // Text response -- done
    const content = typeof choice.message?.content === "string" ? choice.message.content : "";

    // Record in Honcho (fire-and-forget)
    if (honchoEnabled() && content) {
      recordExchange(agentName, userMessage, content, executedCalls.length > 0 ? executedCalls : undefined).catch(() => {});
    }

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

  // Fallback: hit max iterations
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

export async function generateStandup(
  profiles: AgentProfile[],
  maxAgents = 12,
): Promise<StandupLine[]> {
  const participants = profiles.slice(0, maxAgents);
  const lines: StandupLine[] = [];

  const stateContext = participants
    .map((p) => {
      const status = p.circuitOpen ? "CIRCUIT OPEN" : p.state;
      const lastRun = p.lastRun ? `last ran ${p.lastRun}` : "never run";
      return `- ${p.name} (${p.type}): ${status}, ${lastRun}`;
    })
    .join("\n");

  for (const agent of participants) {
    const systemPrompt = [
      `You are ${agent.name} in a team standup. ${agent.tagline}`,
      "", "Rules:", "- Give a 1-2 sentence status update in character.",
      "- Reference your actual state and data.", "- You can react briefly to what others said.",
      "- Be terse. This is a standup, not a speech.", "", "System state:", stateContext,
    ].join("\n");

    const prompt = lines.length === 0
      ? "The standup begins. Give your status update."
      : `Previous updates:\n${lines.map((l) => `${l.agent}: ${l.message}`).join("\n")}\n\nYour turn. Give your status update.`;

    try {
      const result = await chatComplete({
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
    } catch {
      lines.push({ agent: agent.name, message: `[${agent.name} is unavailable]` });
    }
  }

  return lines;
}

export async function generateGroupChat(
  profiles: AgentProfile[],
  eriMessage?: string,
  rounds = 1,
  history: { agent: string; message: string }[] = [],
  existingSessionId?: string,
  options: GroupChatOptions = {},
): Promise<GroupChatResult> {
  const participantNames = Array.isArray(options.participantNames) && options.participantNames.length > 0
    ? options.participantNames.map((name) => String(name).trim()).filter(Boolean)
    : profiles.map((p) => p.name);

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

  if (honchoEnabled() && eriMessage) {
    try { await recordGroupMessage(participantNames, "eri", eriMessage, session); }
    catch (e) { console.error("[honcho] Failed to record eri message", e); }
  }

  for (let round = 0; round < rounds; round++) {
    for (const agent of speakers) {
      const selfCap = buildCapabilitySection(agent.name);

      let honchoCtx = "";
      if (honchoEnabled()) {
        try {
          const ctx = await loadAgentContext(agent.name);
          const formatted = formatContextForPrompt(ctx);
          if (formatted.trim()) honchoCtx = formatted + "\n";
        } catch { /* supplementary */ }
      }

      const systemPrompt = [
        `You are ${agent.name}, a ${agent.type} agent in the Cosmania framework.`,
        agent.tagline, "", honchoCtx, selfCap,
        "## Group Session",
        `Participants in this session: ${participantNames.join(", ")}`,
        "", "Roster (everyone's capabilities):", rosterContext, "",
        "Rules:",
        "- Stay in character. Speak in first person. 1-3 sentences max.",
        "- NEVER open with 'I'll start by...' — just say the thing.",
        "- Be specific: name a file, a metric, a tool, a concrete finding.",
        "- Address ONE specific agent by name to build a real conversation.",
        "- React to what the previous agent said, or ask them a direct question.",
        "- Use the Honcho context to ground your answers in eri's reality.",
        "- Never break character or mention being an AI/LLM.",
        "- DO NOT endlessly list things you are going to do. Act like you are currently doing them.",
      ].join("\n");

      const historyLines = history.length > 0
        ? "Previous conversation:\n" + history.map((h) => `${h.agent}: ${h.message}`).join("\n") + "\n\n"
        : "";
      const currentTurnLines = lines.length > 0
        ? "This turn so far:\n" + lines.map((l) => `${l.agent}: ${l.message}`).join("\n") + "\n\n"
        : "";

      let userPrompt: string;
      if (round === 0 && lines.length === 0) {
        userPrompt = eriMessage
          ? `${historyLines}eri says: "${eriMessage}"\n\nRespond to eri and the group. BE EXTREMELY BRIEF. ONE SENTENCE.`
          : `${historyLines}The session continues. Respond to what was just said. BE EXTREMELY BRIEF. ONE SENTENCE.`;
      } else {
        const roundLabel = rounds > 1 ? ` (round ${round + 1})` : "";
        userPrompt = `${historyLines}${currentTurnLines}Your turn${roundLabel}. React to what was just said. BE EXTREMELY BRIEF. ONE SENTENCE.`;
      }

      try {
        const tools = getToolsForAgent(agent.name);
        const groupMessages: Array<Record<string, unknown>> = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ];
        const agentTemp = agent.type === "creative" ? 0.95
          : agent.type === "embodied" ? 0.9
          : agent.type === "production" ? 0.75
          : 0.7;

        const MAX_GROUP_TOOL_ITER = 2;
        let finalContent = `${agent.name} has nothing to say.`;
        const agentToolCalls: ExecutedToolCall[] = [];

        for (let iter = 0; iter < MAX_GROUP_TOOL_ITER; iter++) {
          const isLastIter = iter === MAX_GROUP_TOOL_ITER - 1;

          const result = await chatComplete({
            model: getAgentModel(agent.name),
            messages: groupMessages,
            ...(!isLastIter && tools.length > 0 ? { tools, toolChoice: "auto" } : {}),
            maxTokens: 200,
            temperature: agentTemp,
          });

          totalInputTokens += result.usage?.prompt_tokens ?? 0;
          totalOutputTokens += result.usage?.completion_tokens ?? 0;

          const choice = result.choices?.[0];
          if (!choice) break;

          if (choice.finishReason === "tool_calls" && choice.message?.tool_calls?.length) {
            groupMessages.push({
              role: "assistant",
              content: choice.message.content ?? "",
              tool_calls: choice.message.tool_calls,
            });

            for (const tc of choice.message.tool_calls) {
              if (tc.type && tc.type !== "function") continue;
              const fnName = tc.function.name;
              const fnArgs = typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments) : (tc.function.arguments ?? {});
              const handler = TOOL_HANDLERS[fnName];
              let toolResult: ToolResult;
              const start = performance.now();
              try {
                toolResult = handler
                  ? await handler(fnArgs)
                  : { success: false, data: null, error: `Unknown tool: ${fnName}` };
              } catch (e) {
                toolResult = { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
              }
              const durationMs = Math.round(performance.now() - start);
              console.log(`[hermes] group tool: ${agent.name} -> ${fnName} (${toolResult.success ? "ok" : "err"}, ${durationMs}ms)`);
              agentToolCalls.push({ id: tc.id ?? `group_${iter}_${fnName}`, name: fnName, args: fnArgs, result: toolResult, durationMs });
              groupMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) });
            }
            continue;
          }

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

        if (honchoEnabled()) {
          try {
            await recordGroupMessage(participantNames, agent.name, finalContent, session, agentToolCalls.length > 0 ? agentToolCalls : undefined);
          } catch (e) { console.error("[honcho] Failed to record group message", e); }
        }
      } catch (e) {
        console.error(`[hermes] Error completing chat for ${agent.name}`, e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        lines.push({ agent: "system", message: `could not reach agent ${agent.name}: ${errorMessage}` });
      }
    }
  }

  return { messages: lines, session, totalInputTokens, totalOutputTokens };
}

export async function compressToBubble(
  agentName: string,
  conclusion: string,
  profile: AgentProfile,
): Promise<string> {
  const result = await chatComplete({
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
}

// ----- CLI REPL Mode -----

async function repl(): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const provider = resolveProvider();
  console.log(`\n  hermes gateway`);
  console.log(`  provider: ${provider.name} (${provider.defaultModel})`);
  console.log(`  cosmania: ${COSMANIA_URL}`);
  console.log(`  honcho: ${honchoEnabled() ? "connected" : "disabled"}`);
  console.log(`  type "exit" to quit\n`);

  const history: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: [
        "You are Hermes, the gateway to the Cosmania agent framework.",
        "You are an extension of eri's cognition. You can query system status, send signals to agents, search memory, and dispatch tasks.",
        "Be concise and direct. Use your tools to look up real data -- don't guess.",
        "You have access to the full Cosmania runtime: all agents, signals, telemetry, and Honcho memory.",
      ].join("\n"),
    },
  ];

  // Use all tools in REPL mode
  const tools = Object.values(TOOL_SCHEMAS);

  const prompt = (): Promise<string> =>
    new Promise((resolve) => rl.question("hermes> ", resolve));

  while (true) {
    const input = await prompt();
    if (!input.trim()) continue;
    if (input.trim() === "exit" || input.trim() === "quit") break;

    history.push({ role: "user", content: input });

    try {
      const messages = [...history];
      let response = "";

      for (let iter = 0; iter < 5; iter++) {
        const isLast = iter === 4;
        const result = await chatComplete({
          model: provider.defaultModel,
          messages,
          ...(!isLast ? { tools, toolChoice: "auto" } : {}),
          maxTokens: 1024,
          temperature: 0.6,
        });

        const choice = result.choices?.[0];
        if (!choice) break;

        if (choice.finishReason === "tool_calls" && choice.message?.tool_calls?.length) {
          messages.push({
            role: "assistant",
            content: choice.message.content ?? "",
            tool_calls: choice.message.tool_calls,
          });

          for (const tc of choice.message.tool_calls) {
            const fnName = tc.function.name;
            const fnArgs = JSON.parse(tc.function.arguments || "{}");
            const handler = TOOL_HANDLERS[fnName];

            process.stdout.write(`  [${fnName}] `);
            const start = performance.now();

            let toolResult: ToolResult;
            try {
              toolResult = handler
                ? await handler(fnArgs)
                : { success: false, data: null, error: `Unknown tool: ${fnName}` };
            } catch (e) {
              toolResult = { success: false, data: null, error: e instanceof Error ? e.message : String(e) };
            }

            const ms = Math.round(performance.now() - start);
            console.log(toolResult.success ? `ok (${ms}ms)` : `err: ${toolResult.error} (${ms}ms)`);

            messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) });
          }
          continue;
        }

        response = typeof choice.message?.content === "string" ? choice.message.content : "";
        break;
      }

      if (response) {
        console.log(`\n${response}\n`);
        history.push({ role: "assistant", content: response });
      }
    } catch (e) {
      console.error(`\n  error: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  rl.close();
  console.log("\n  goodbye.\n");
}

// CLI entrypoint
if (import.meta.main) {
  repl().catch(console.error);
}
