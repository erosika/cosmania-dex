/**
 * COSMANIA DEX -- Canvas Game Engine
 *
 * Grid view: 4x3 agent sprites with selection cursor + idle animations
 * Profile view: detailed agent stats + LIVE CHAT with agents
 * Bubble system: cycles through all agents, showing real speech bubbles
 * Input: Gamepad API (Anbernic d-pad) + keyboard fallback
 */

// ---- Constants ----

// Dynamically balance grid to current screen size and sprite scale
const SPRITE_SIZE = 32;
const SPRITE_SCALE = Math.max(1, Math.floor(window.devicePixelRatio || 1));
const SPRITE_DISPLAY = SPRITE_SIZE * SPRITE_SCALE;
const GRID_GAP = Math.max(8, Math.floor(SPRITE_DISPLAY * 0.3));

// Helper: Compute columns and rows to fit canvas wrapper at load
function computeGridDims() {
  const wrap = document.getElementById("canvas-wrap");
  if (!wrap) return { cols: 8, rows: 10 }; // fallback
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;
  const cols = Math.max(4, Math.floor((width + GRID_GAP) / (SPRITE_DISPLAY + GRID_GAP)));
  const rows = Math.max(3, Math.floor((height + GRID_GAP) / (SPRITE_DISPLAY + GRID_GAP)));
  return { cols, rows };
}

let { cols: GRID_COLS, rows: GRID_ROWS } = computeGridDims();

// Redefine on resize
window.addEventListener('resize', () => {
  const dims = computeGridDims();
  GRID_COLS = dims.cols;
  GRID_ROWS = dims.rows;
});

// Size of a cell in the grid
const CELL_SIZE = SPRITE_DISPLAY + GRID_GAP;

// Bubble and data timing, kept balanced for good UX
const BUBBLE_ROTATE_MS = 4800; // quick enough for cycle, not too distracting
const BUBBLE_VISIBLE_MS = 2600;
const BUBBLE_FADE_MS = 380;
const DATA_REFRESH_MS = 12000; // regular freshness but not spammy
const MINI_PROFILE_BUBBLE_LIMIT = 120;
const MINI_PROFILE_RUNS_CAP = 16;
const EVENT_LOG_LIMIT = 220;
const EVENT_LOG_RENDER_LIMIT = 180;
const EVENT_LOG_DEFAULT_COOLDOWN_MS = 1200;
const EVENT_LOG_MAX_AGE_MS = 38000;
const EVENT_LOG_FADE_START_MS = 14000;
const EVENT_LOG_REPAINT_MS = 280;
const EVENT_LOG_SCROLL_TOP_STICKY_PX = 10;
const EVENT_LOG_SEARCH_LIMIT = 260;
const EVENT_LOG_SEARCH_DEBOUNCE_MS = 220;
const CHAT_INPUT_DEFAULT_PLACEHOLDER = "talk to this agent...";
const EVENT_UPLOAD_BATCH_MS = 1200;
const EVENT_UPLOAD_MAX_BATCH = 36;
const EVENT_UPLOAD_QUEUE_LIMIT = 1200;
const EVENT_BOOTSTRAP_LOAD_LIMIT = 180;
const EVENT_SERVER_POLL_MS = 3200;
const EVENT_SERVER_POLL_LIMIT = 180;
const CAMPFIRE_UPDATES_POLL_MS = 2500;
const CAMPFIRE_UPDATES_LIMIT = 90;
const CAMPFIRE_TRACE_RENDER_LIMIT = 140;
const DJ_AGENT_NAME = "dj";
const DJ_CONTROL_HISTORY_LIMIT = 12;
const DJ_STATUS_TEXT_LIMIT = 96;
const MODEL_ICON_ORBIT_SPEED = 0.0022;
const MODEL_ICON_FLOAT_AMPLITUDE = 2.8;
const MOVE_TARGET_BLEND = 0.2;
const MOVE_IDLE_DAMP = 0.82;
const MOVE_FACING_DEADZONE = 0.003;
const WALK_ARRIVE_RADIUS = 7;
const WALK_SLOW_RADIUS = 28;
const SETTINGS_STORAGE_KEY = "cosmania-dex:ui-settings:v1";
const DEFAULT_CAMPFIRE_LABEL = "Session";


const TYPE_COLORS = {
  infrastructure: "#7eb8f6",
  creative: "#bc8cff",
  production: "#5ec9b3",
  embodied: "#f0a0b0",
};

const STATE_COLORS = {
  healthy: "#7ee6a8",
  working: "#7eb8f6",
  sick: "#f47067",
  sleeping: "#6e7681",
};

const PIXEL_ZONE = {
  VOID: 0,
  ATMOSPHERE: 1,
  CORE: 2,
  BOUNDARY: 3,
  INTERACTION: 4,
  TERRAIN: 5,
};

// Hand-authorable world topology: boundaries + interaction hot spots.
const WORLD_LAYOUT = {
  core: {
    xPct: 0.5,
    yPct: 0.44,
    radiusXPct: 0.36,
    radiusYPct: 0.33,
  },
  terrain: {
    baselinePct: 0.8,
    waveAmp: 3,
    waveFreq: 0.05,
  },
  zoneThresholds: {
    boundaryOuter: 1.12,
    boundaryInner: 1.0,
    coreInner: 0.42,
    boundaryLineWidthSq: 4,
  },
  interactionNodes: [
    { id: "north_gate", xPct: 0.5, yPct: 0.2, radius: 14, speed: 0.95, phase: 0.2 },
    { id: "north_west", xPct: 0.34, yPct: 0.3, radius: 13, speed: 1.02, phase: 0.8 },
    { id: "north_east", xPct: 0.66, yPct: 0.3, radius: 13, speed: 1.09, phase: 1.4 },
    { id: "west_gate", xPct: 0.27, yPct: 0.45, radius: 12, speed: 1.16, phase: 1.9 },
    { id: "east_gate", xPct: 0.73, yPct: 0.45, radius: 12, speed: 1.24, phase: 2.6 },
    { id: "south_west", xPct: 0.38, yPct: 0.61, radius: 14, speed: 1.29, phase: 3.1 },
    { id: "south_east", xPct: 0.62, yPct: 0.61, radius: 14, speed: 1.34, phase: 3.7 },
    { id: "south_gate", xPct: 0.5, yPct: 0.68, radius: 13, speed: 1.4, phase: 4.2 },
    { id: "core_hub", xPct: 0.5, yPct: 0.44, radius: 18, speed: 1.5, phase: 4.8 },
  ],
  boundaryLinks: [
    ["north_gate", "north_west"],
    ["north_west", "west_gate"],
    ["west_gate", "south_west"],
    ["south_west", "south_gate"],
    ["south_gate", "south_east"],
    ["south_east", "east_gate"],
    ["east_gate", "north_east"],
    ["north_east", "north_gate"],
    ["core_hub", "north_gate"],
    ["core_hub", "north_west"],
    ["core_hub", "north_east"],
    ["core_hub", "west_gate"],
    ["core_hub", "east_gate"],
    ["core_hub", "south_west"],
    ["core_hub", "south_east"],
    ["core_hub", "south_gate"],
    ["north_west", "north_east"],
    ["south_west", "south_east"],
  ],
  // Agents prefer these nodes when selecting intentional targets.
  agentTargetNodeIds: [
    "north_gate",
    "north_west",
    "north_east",
    "west_gate",
    "east_gate",
    "south_west",
    "south_east",
    "south_gate",
    "core_hub",
  ],
};

const DEFAULT_WORLD_LAYOUT = JSON.parse(JSON.stringify(WORLD_LAYOUT));

// ---- State ----

let agents = [];
let selectedIndex = 0;
let view = "grid"; // "grid" | "profile"
let spriteImages = {};
let bubbleIndex = 0;
let lastBubbleRotate = 0;
let bubbleVisibleUntil = 0;
let activeBubbleAgentName = "";
let activeBubbleText = "";
let lastDataFetch = 0;
let placeholderSprites = {};
let profileData = null;
let profileAgent = null;
let gamepadPrevButtons = {};
let chatHistory = {}; // per-agent: { agentName: [{role, content}] }
let traceHistory = {}; // per-agent: { agentName: [{id, name, args, result, durationMs}] }
let traceExpandedIds = {}; // per-agent: { agentName: Set<id> }
let traceFilterIds = {}; // per-agent: { agentName: Set<id> | null } -- when set, only show these
let chatSending = false;
let pendingUpload = null; // { id, filename, path, size, contentHash, objectUrl }
let voicePlaying = false;
let currentAudio = null;
let campfireSelected = new Set(); // agent names selected for campfire
let campfireMessages = []; // { agent, message, type }
let campfireSending = false;
let campfireSessionId = null; // Honcho session ID -- persists when peers change
let campfireUpdatesTimer = null;
let campfireUpdatesInFlight = false;
let campfireUpdateSinceTs = 0;
let campfireSeenRecordIds = new Set();
let campfireTraceEntries = []; // { id, agent, name, ok, durationMs, argsPreview, resultPreview, tsMs }
let campfireSeenTraceIds = new Set();
let djControlInFlight = false;
let djStatusText = "idle";
let djStatusMode = "idle"; // "idle" | "playing" | "paused" | "error"
let lastTimestamp = 0;
let pixelField = null;
let worldInteractionPoints = [];
let worldMenuOpen = false;
let agentMenuOpen = false;
let agentMenuAgentName = null;
let agentProfileWindowOpen = false;
let agentProfileWindowAgentName = null;
let agentProfileWindowAnchor = null;
let agentProfileWindowDetails = null;
let profilePanelMenuMode = false;
let profilePanelMenuAnchor = null;
let spriteLoadState = {}; // per-agent: "loading" | "loaded" | "error"
let modelIconImages = {}; // per-icon-src Image
let modelIconLoadState = {}; // per-icon-src: "loading" | "loaded" | "error"
let tracePanelVisible = true;

// Model picker state
let modelPickerOpen = false;
let modelPickerIndex = 0;
let modelPickerAgent = null;
let modelPickerCurrentModel = null; // model ID currently active for the agent
let agentModelInfo = {}; // per-agent model metadata for floating icon tags
let agentModelFetchState = {}; // per-agent: "loading" | "loaded" | "error"
let eventLogEntries = []; // [{ ts, time, message, kind }]
let eventLogLastByKey = {}; // dedupe key -> timestamp
let eventLogCollapsed = false;
let eventLogLastRepaint = 0;
let eventLogLastMarkup = "";
let eventLogSearchQuery = "";
let eventLogSearchSemantic = true;
let eventLogSearchKind = "all";
let eventLogToolsOpen = false;
let eventLogSearchResults = null; // null when no active query; [] when queried with no matches
let eventLogSearchInFlight = false;
let eventLogSearchDebounceTimer = null;
let eventLogSearchSeq = 0;
let eventLogRenderedEntries = []; // currently rendered, click-resolvable event rows
let activeChatEventContext = null; // { agentName, time, kind, message, ts }
let eventUploadQueue = []; // events pending persistence POST /api/events
let eventUploadInFlight = false;
let eventUploadLastSentAt = 0;
let eventServerPollInFlight = false;
let eventServerLastPollAt = 0;
let eventServerLastSyncTs = 0;
let eventServerSeenKeys = new Set();
let hiddenAgentNames = new Set(); // lower-case agent names hidden from UI
let settingsMenuOpen = false;
let campfireLabel = DEFAULT_CAMPFIRE_LABEL;

const MODEL_REGISTRY = [
  // -- Generalist (tool use) --
  { name: "Small", modelId: "mistral-small-latest", icon: "sprites/models/Small.png", toolUse: true },
  { name: "Medium", modelId: "mistral-medium-latest", icon: "sprites/models/Medium.png", toolUse: true },
  { name: "Large", modelId: "mistral-large-latest", icon: "sprites/models/Large.png", toolUse: true },
  { name: "Small Creative", modelId: "labs-mistral-small-creative", icon: "sprites/models/Small.png", toolUse: true },
  { name: "Ministral 8B", modelId: "ministral-8b-latest", icon: "sprites/models/Ministral.png", toolUse: true },
  { name: "Ministral 14B", modelId: "ministral-14b-latest", icon: "sprites/models/Ministral.png", toolUse: true },
  { name: "Ministral 3B", modelId: "ministral-3b-latest", icon: "sprites/models/Ministral.png", toolUse: true },
  // -- Code (tool use) --
  { name: "Codestral", modelId: "codestral-latest", icon: "sprites/models/Codestral.png", toolUse: true },
  { name: "Devstral", modelId: "devstral-small-latest", icon: "sprites/models/Devstral.png", toolUse: true },
  { name: "Devstral 2", modelId: "devstral-latest", icon: "sprites/models/Devstral.png", toolUse: true },
  // -- Reasoning (tool use) --
  { name: "Magistral Med", modelId: "magistral-medium-latest", icon: "sprites/models/Magistral.png", toolUse: true },
  { name: "Magistral Sm", modelId: "magistral-small-latest", icon: "sprites/models/Magistral.png", toolUse: true },
  // -- Voice (tool use) --
  { name: "Voxtral", modelId: "voxtral-small-latest", icon: "sprites/models/Voxtral.png", toolUse: true },
  // -- Vision / legacy (no tool use) --
  { name: "Pixtral", modelId: "pixtral-large-latest", icon: "sprites/models/Pixtral.png", toolUse: false },
  { name: "Nemo", modelId: "open-mistral-nemo", icon: "sprites/models/Nemo.png", toolUse: false },
  { name: "Mamba", modelId: "open-codestral-mamba", icon: "sprites/models/Mamba.png", toolUse: false },
  { name: "Mathstral", modelId: "open-mathstral-7b", icon: "sprites/models/Mathstral.png", toolUse: false },
  { name: "7B", modelId: "open-mistral-7b", icon: "sprites/models/7B.png", toolUse: false },
  { name: "SABA", modelId: "mistral-saba-latest", icon: "sprites/models/SABA.png", toolUse: false },
  // -- Utility (non-chat) --
  { name: "Embed", modelId: "mistral-embed-latest", icon: "sprites/models/Embed.png", toolUse: false },
  { name: "Codestral Embed", modelId: "codestral-embed-2505", icon: "sprites/models/CodestralEmbed.png", toolUse: false },
  { name: "Classifier", modelId: "mistral-classifier-latest", icon: "sprites/models/Classifier.png", toolUse: false },
  { name: "OCR", modelId: "mistral-ocr-latest", icon: "sprites/models/OCR.png", toolUse: false },
  { name: "Moderation", modelId: "mistral-moderation-latest", icon: "sprites/models/Moderation.png", toolUse: false },
];

function getModelRegistryEntry(modelId) {
  return MODEL_REGISTRY.find((entry) => entry.modelId === modelId) || null;
}

function getModelBadgeLabel(modelId) {
  if (!modelId) return "";
  const fromRegistry = getModelRegistryEntry(modelId);
  if (fromRegistry?.name) {
    const token = fromRegistry.name.toUpperCase().split(/\s+/)[0] || fromRegistry.name.toUpperCase();
    return token.slice(0, 7);
  }
  const cleaned = String(modelId).replace(/-latest$/i, "").replace(/^open-/i, "").toUpperCase();
  const token = cleaned.split(/[-_]/)[0] || cleaned;
  return token.slice(0, 7);
}

function getModelDisplayName(modelId) {
  if (!modelId) return "model ...";
  const fromRegistry = getModelRegistryEntry(modelId);
  if (fromRegistry?.name) return fromRegistry.name;
  return String(modelId)
    .replace(/-latest$/i, "")
    .replace(/^open-/i, "")
    .replace(/-/g, " ");
}

function triggerHapticFeedback(pattern = 22) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // no-op when vibration is unavailable
  }
}

function normalizeAssetPath(path) {
  if (typeof path !== "string" || !path.trim()) return "";
  const clean = path.trim().replace(/^\.?\//, "");
  return `/${clean}`;
}

function getModelIconPath(modelId) {
  const entry = getModelRegistryEntry(modelId);
  if (!entry?.icon) return "";
  return normalizeAssetPath(entry.icon);
}

function getModelIconImage(modelMeta) {
  if (!modelMeta?.iconPath) return null;
  const cached = modelIconImages[modelMeta.iconPath];
  if (cached) return cached;
  loadModelIconBySrc(modelMeta.iconPath);
  return null;
}

function setAgentModelInfo(agentName, info) {
  if (!agentName) return;
  if (!info || !info.model) {
    agentModelInfo[agentName] = { modelId: "", label: "", iconPath: "", isOverride: false };
    return;
  }
  const iconPath = getModelIconPath(info.model);
  if (iconPath) loadModelIconBySrc(iconPath);
  agentModelInfo[agentName] = {
    modelId: info.model,
    label: getModelBadgeLabel(info.model),
    iconPath,
    isOverride: Boolean(info.isOverride),
  };
}

async function fetchAgentModelInfo(agentName, force = false) {
  if (!agentName) return null;
  const state = agentModelFetchState[agentName];
  if (!force && (state === "loading" || state === "loaded")) {
    return agentModelInfo[agentName] || null;
  }
  agentModelFetchState[agentName] = "loading";
  try {
    const res = await fetch(`/api/agent/${agentName}/model`);
    if (!res.ok) throw new Error(`${res.status}`);
    const info = await res.json();
    setAgentModelInfo(agentName, info);
    agentModelFetchState[agentName] = "loaded";
    return agentModelInfo[agentName];
  } catch {
    agentModelFetchState[agentName] = "error";
    return null;
  }
}

function formatEventTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function hydrateEventEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const id = typeof entry.id === "string" && entry.id.trim()
    ? entry.id.trim()
    : null;
  const tsIso = typeof entry.ts === "string"
    ? entry.ts
    : (typeof entry.receivedAt === "string" ? entry.receivedAt : "");
  const parsedTs = Date.parse(tsIso);
  const ts = Number.isFinite(parsedTs) ? parsedTs : Date.now();
  const message = typeof entry.message === "string" ? entry.message.trim() : "";
  if (!message) return null;

  const kind = typeof entry.kind === "string" && entry.kind.trim()
    ? entry.kind.trim().toLowerCase()
    : "info";

  return {
    id,
    ts,
    time: formatEventTime(ts),
    message,
    kind,
    agentName: typeof entry.agentName === "string" && entry.agentName.trim()
      ? entry.agentName.trim()
      : null,
    source: entry.source === "server" ? "server" : "client",
    meta: entry.meta && typeof entry.meta === "object" && !Array.isArray(entry.meta)
      ? entry.meta
      : null,
  };
}

function getServerEventMergeKey(entry) {
  if (entry && entry.id) return `id:${entry.id}`;
  return [
    "server-fallback",
    String(entry?.ts ?? ""),
    String(entry?.kind ?? ""),
    String(entry?.agentName ?? ""),
    String(entry?.message ?? ""),
  ].join(":");
}

function rebuildServerEventSeenSet() {
  const next = new Set();
  let latestTs = 0;
  for (const entry of eventLogEntries) {
    if (!entry || entry.source !== "server") continue;
    next.add(getServerEventMergeKey(entry));
    if (entry.ts > latestTs) latestTs = entry.ts;
  }
  eventServerSeenKeys = next;
  eventServerLastSyncTs = latestTs;
}

function mergeServerEvents(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const serverEntries = entries
    .filter((entry) => entry && entry.source === "server")
    .sort((a, b) => a.ts - b.ts);

  if (serverEntries.length === 0) return false;

  let changed = false;
  for (const entry of serverEntries) {
    const key = getServerEventMergeKey(entry);
    if (eventServerSeenKeys.has(key)) continue;
    eventServerSeenKeys.add(key);
    if (entry.ts > eventServerLastSyncTs) {
      eventServerLastSyncTs = entry.ts;
    }
    eventLogEntries.unshift(entry);
    changed = true;
  }

  if (changed && eventLogEntries.length > EVENT_LOG_LIMIT) {
    eventLogEntries.length = EVENT_LOG_LIMIT;
  }
  if (eventServerSeenKeys.size > EVENT_LOG_LIMIT * 30) {
    rebuildServerEventSeenSet();
  }
  return changed;
}

function shouldShowEventLog() {
  return view === "grid";
}

function isEventSearchMode() {
  return Boolean(eventLogSearchQuery.trim());
}

function shouldAutoRepaintEventLog() {
  if (!shouldShowEventLog() || eventLogCollapsed) return false;
  if (isEventSearchMode()) return eventLogSearchInFlight;
  const container = document.getElementById("event-log-entries");
  if (!container) return true;
  return container.scrollTop <= EVENT_LOG_SCROLL_TOP_STICKY_PX;
}

function eventRowsForRender(now) {
  if (!isEventSearchMode()) {
    eventLogEntries = eventLogEntries.filter((entry) => now - entry.ts <= EVENT_LOG_MAX_AGE_MS);
  }

  let rows = isEventSearchMode()
    ? (Array.isArray(eventLogSearchResults) ? eventLogSearchResults : [])
    : eventLogEntries;

  if (eventLogSearchKind !== "all") {
    rows = rows.filter((entry) => entry.kind === eventLogSearchKind);
  }

  return rows.slice(0, EVENT_LOG_RENDER_LIMIT);
}

function toDialogEventText(entry) {
  const raw = typeof entry?.message === "string" ? entry.message.trim() : "";
  if (!raw) return "...";

  // Surface failures as concise report-dialog language.
  if (/returned an error/i.test(raw)) {
    return "report failed";
  }
  if (/unreachable/i.test(raw)) {
    return "report failed: unreachable";
  }
  if (/(campfire|session) error:/i.test(raw)) {
    return raw.replace(/(?:campfire|session) error:/i, "report failed:").trim();
  }

  const repliedMatch = raw.match(/^[^:]+ replied:\s*(.+)$/i);
  if (repliedMatch?.[1]) return repliedMatch[1].trim();

  const prefixedAgentMatch = raw.match(/^([a-z0-9_-]+):\s+(.+)$/i);
  if (
    prefixedAgentMatch &&
    entry?.agentName &&
    prefixedAgentMatch[1].toLowerCase() === String(entry.agentName).toLowerCase()
  ) {
    return prefixedAgentMatch[2].trim();
  }

  return raw;
}

function renderEventLog() {
  const panel = document.getElementById("event-log-panel");
  const container = document.getElementById("event-log-entries");
  const toggleBtn = document.getElementById("event-log-toggle");
  const toolsToggleBtn = document.getElementById("event-log-tools-toggle");
  const searchInput = document.getElementById("event-log-search");
  const kindSelect = document.getElementById("event-log-kind");
  const semanticBtn = document.getElementById("event-log-semantic");
  if (!panel || !container) return;

  const shouldShow = shouldShowEventLog();
  panel.hidden = !shouldShow;
  if (!shouldShow) {
    eventLogRenderedEntries = [];
    return;
  }

  panel.classList.toggle("collapsed", eventLogCollapsed);
  const toolsVisible = eventLogToolsOpen || isEventSearchMode();
  panel.classList.toggle("tools-open", toolsVisible);
  panel.setAttribute("data-mode", isEventSearchMode() ? "search" : "live");
  panel.setAttribute("data-semantic", eventLogSearchSemantic ? "on" : "off");

  if (searchInput && searchInput.value !== eventLogSearchQuery) {
    searchInput.value = eventLogSearchQuery;
  }
  if (kindSelect && kindSelect.value !== eventLogSearchKind) {
    kindSelect.value = eventLogSearchKind;
  }
  if (semanticBtn) {
    semanticBtn.setAttribute("aria-pressed", eventLogSearchSemantic ? "true" : "false");
  }
  if (toolsToggleBtn) {
    toolsToggleBtn.setAttribute("aria-pressed", toolsVisible ? "true" : "false");
  }

  if (toggleBtn) {
    toggleBtn.textContent = eventLogCollapsed ? ">" : "<";
    toggleBtn.setAttribute("aria-expanded", eventLogCollapsed ? "false" : "true");
    toggleBtn.setAttribute("aria-label", eventLogCollapsed ? "Expand event log" : "Collapse event log");
  }

  if (eventLogCollapsed) {
    eventLogRenderedEntries = [];
    return;
  }

  const now = Date.now();
  const searchMode = isEventSearchMode();
  const visibleEntries = eventRowsForRender(now);

  if (!visibleEntries.length) {
    eventLogRenderedEntries = [];
    if (searchMode && eventLogSearchInFlight) {
      const searchingMarkup = '<div class="event-log-empty">searching semantic matches...</div>';
      if (searchingMarkup !== eventLogLastMarkup) {
        container.innerHTML = searchingMarkup;
        eventLogLastMarkup = searchingMarkup;
      }
      return;
    }
    const emptyText = searchMode
      ? `no matches for "${escapeHtml(eventLogSearchQuery.trim())}"`
      : "events appear here";
    const emptyMarkup = `<div class="event-log-empty">${emptyText}</div>`;
    if (emptyMarkup !== eventLogLastMarkup) {
      container.innerHTML = emptyMarkup;
      eventLogLastMarkup = emptyMarkup;
      container.scrollTop = 0;
    }
    return;
  }

  eventLogRenderedEntries = visibleEntries.slice();
  const previousScrollTop = container.scrollTop;
  const previousScrollHeight = container.scrollHeight;
  const stickToTop = previousScrollTop <= EVENT_LOG_SCROLL_TOP_STICKY_PX;
  const markup = visibleEntries
    .map((entry, index) => {
      const age = now - entry.ts;
      const fadeProgress = searchMode || age <= EVENT_LOG_FADE_START_MS
        ? 0
        : Math.min(1, (age - EVENT_LOG_FADE_START_MS) / (EVENT_LOG_MAX_AGE_MS - EVENT_LOG_FADE_START_MS));
      const alpha = Math.max(0.08, 1 - fadeProgress);
      const dialogText = toDialogEventText(entry);
      const targetAgentName = resolveEventAgentName(entry);
      const clickable = Boolean(targetAgentName);
      const agentLabel = entry.agentName
        ? `<span class="event-log-agent">${escapeHtml(entry.agentName)}</span>`
        : "";
      return `<div class="event-log-entry" data-event-index="${index}" data-kind="${escapeHtml(entry.kind)}" data-clickable="${clickable ? "true" : "false"}" style="opacity:${alpha.toFixed(3)}"><span class="event-log-time">${entry.time}</span><span class="event-log-text">${agentLabel}${escapeHtml(dialogText)}</span></div>`;
    })
    .join("");

  if (markup === eventLogLastMarkup) return;
  container.innerHTML = markup;
  eventLogLastMarkup = markup;
  if (stickToTop) {
    container.scrollTop = 0;
    return;
  }
  const nextScrollHeight = container.scrollHeight;
  container.scrollTop = Math.max(0, previousScrollTop + (nextScrollHeight - previousScrollHeight));
}

function syncEventLogVisibility() {
  const panel = document.getElementById("event-log-panel");
  if (!panel) return;
  const shouldShow = shouldShowEventLog();
  if (panel.hidden !== !shouldShow) {
    panel.hidden = !shouldShow;
  }
}

function setEventLogCollapsed(collapsed) {
  const next = Boolean(collapsed);
  if (eventLogCollapsed === next) return;
  eventLogCollapsed = next;
  eventLogLastMarkup = "";
  renderEventLog();
}

function setEventLogToolsOpen(open) {
  const next = Boolean(open);
  if (eventLogToolsOpen === next) return;
  eventLogToolsOpen = next;
  renderEventLog();
}

function queueEventSearch(immediate = false) {
  if (eventLogSearchDebounceTimer !== null) {
    clearTimeout(eventLogSearchDebounceTimer);
    eventLogSearchDebounceTimer = null;
  }

  if (!isEventSearchMode()) {
    eventLogSearchSeq += 1;
    eventLogSearchInFlight = false;
    eventLogSearchResults = null;
    eventLogLastMarkup = "";
    renderEventLog();
    return;
  }

  if (immediate) {
    void runEventSearch();
    return;
  }

  eventLogSearchDebounceTimer = window.setTimeout(() => {
    eventLogSearchDebounceTimer = null;
    void runEventSearch();
  }, EVENT_LOG_SEARCH_DEBOUNCE_MS);
}

async function runEventSearch() {
  const query = eventLogSearchQuery.trim();
  if (!query) {
    eventLogSearchResults = null;
    eventLogSearchInFlight = false;
    eventLogLastMarkup = "";
    renderEventLog();
    return;
  }

  const requestSeq = ++eventLogSearchSeq;
  eventLogSearchInFlight = true;
  eventLogLastMarkup = "";
  renderEventLog();

  try {
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("limit", String(EVENT_LOG_SEARCH_LIMIT));
    params.set("semantic", eventLogSearchSemantic ? "1" : "0");
    if (eventLogSearchKind !== "all") {
      params.set("kinds", eventLogSearchKind);
    }

    const res = await fetch(`/api/events/search?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`search failed: ${res.status}`);
    }

    const data = await res.json();
    if (requestSeq !== eventLogSearchSeq) return;

    const hydrated = Array.isArray(data?.events)
      ? data.events.map(hydrateEventEntry).filter(Boolean)
      : [];
    eventLogSearchResults = hydrated;
  } catch {
    if (requestSeq !== eventLogSearchSeq) return;
    eventLogSearchResults = [];
  } finally {
    if (requestSeq !== eventLogSearchSeq) return;
    eventLogSearchInFlight = false;
    eventLogLastMarkup = "";
    renderEventLog();
  }
}

function clearEventSearch() {
  if (eventLogSearchDebounceTimer !== null) {
    clearTimeout(eventLogSearchDebounceTimer);
    eventLogSearchDebounceTimer = null;
  }
  eventLogSearchSeq += 1;
  eventLogSearchInFlight = false;
  eventLogSearchQuery = "";
  eventLogSearchResults = null;
  const searchInput = document.getElementById("event-log-search");
  if (searchInput) searchInput.value = "";
  eventLogLastMarkup = "";
  renderEventLog();
}

function handleEventLogClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest(".event-log-entry");
  if (!(row instanceof HTMLElement)) return;

  const clickable = row.getAttribute("data-clickable");
  if (clickable !== "true") return;

  const indexRaw = row.getAttribute("data-event-index");
  const entryIndex = Number.parseInt(indexRaw ?? "-1", 10);
  if (!Number.isFinite(entryIndex) || entryIndex < 0 || entryIndex >= eventLogRenderedEntries.length) return;

  const entry = eventLogRenderedEntries[entryIndex];
  if (!entry) return;
  startConversationFromEvent(entry);
}

function enqueueEventForPersistence(payload) {
  if (!payload || typeof payload.message !== "string" || !payload.message.trim()) return;
  eventUploadQueue.push(payload);
  if (eventUploadQueue.length > EVENT_UPLOAD_QUEUE_LIMIT) {
    eventUploadQueue.splice(0, eventUploadQueue.length - EVENT_UPLOAD_QUEUE_LIMIT);
  }
  if (eventUploadQueue.length >= EVENT_UPLOAD_MAX_BATCH) {
    void flushEventUploads(true);
  }
}

async function flushEventUploads(force = false) {
  if (eventUploadInFlight || eventUploadQueue.length === 0) return;

  const now = Date.now();
  if (!force && now - eventUploadLastSentAt < EVENT_UPLOAD_BATCH_MS) return;

  eventUploadInFlight = true;
  eventUploadLastSentAt = now;
  const batch = eventUploadQueue.splice(0, EVENT_UPLOAD_MAX_BATCH);

  try {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) {
      throw new Error(`event upload failed: ${res.status}`);
    }
  } catch {
    // Push failed batch back to the front to avoid drops.
    eventUploadQueue = batch.concat(eventUploadQueue).slice(0, EVENT_UPLOAD_QUEUE_LIMIT);
  } finally {
    eventUploadInFlight = false;
  }
}

function flushEventsOnPageHide() {
  if (!eventUploadQueue.length) return;
  const nav = window.navigator;
  if (!nav || typeof nav.sendBeacon !== "function") return;

  const batch = eventUploadQueue.splice(0, EVENT_UPLOAD_MAX_BATCH);
  const payload = JSON.stringify({ events: batch });
  const blob = new Blob([payload], { type: "application/json" });
  const ok = nav.sendBeacon("/api/events", blob);
  if (!ok) {
    eventUploadQueue = batch.concat(eventUploadQueue).slice(0, EVENT_UPLOAD_QUEUE_LIMIT);
  }
}

async function loadPersistedEvents() {
  try {
    const res = await fetch(`/api/events?limit=${EVENT_BOOTSTRAP_LOAD_LIMIT}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.events)) return;

    const hydrated = data.events
      .map(hydrateEventEntry)
      .filter(Boolean);

    if (hydrated.length > 0) {
      eventLogEntries = hydrated.slice(0, EVENT_LOG_LIMIT);
      rebuildServerEventSeenSet();
      eventLogLastMarkup = "";
    }
  } catch {
    // best effort only
  }
}

async function pollServerEvents(now = Date.now()) {
  if (eventServerPollInFlight) return;
  if (now - eventServerLastPollAt < EVENT_SERVER_POLL_MS) return;
  eventServerLastPollAt = now;
  eventServerPollInFlight = true;

  try {
    const params = new URLSearchParams();
    params.set("limit", String(EVENT_SERVER_POLL_LIMIT));
    if (eventServerLastSyncTs > 0) {
      params.set("since", new Date(Math.max(0, eventServerLastSyncTs - 1000)).toISOString());
    }

    const res = await fetch(`/api/events?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.events)) return;
    const hydrated = data.events
      .map(hydrateEventEntry)
      .filter(Boolean);
    const changed = mergeServerEvents(hydrated);
    if (changed) {
      eventLogLastMarkup = "";
      if (!isEventSearchMode()) {
        renderEventLog();
      }
    }
  } catch {
    // best effort only
  } finally {
    eventServerPollInFlight = false;
  }
}

function logAgentEvent(message, options = {}) {
  if (!message) return;
  const now = Date.now();
  const kind = options.kind || "info";
  const agentName = options.agentName || null;
  const meta = options.meta && typeof options.meta === "object" ? options.meta : undefined;
  const cooldownMs = typeof options.cooldownMs === "number"
    ? options.cooldownMs
    : EVENT_LOG_DEFAULT_COOLDOWN_MS;
  const dedupeKey = options.dedupeKey || `${kind}:${agentName || ""}:${message}`;

  if (dedupeKey) {
    const lastAt = eventLogLastByKey[dedupeKey];
    if (typeof lastAt === "number" && now - lastAt < cooldownMs) return;
    eventLogLastByKey[dedupeKey] = now;
  }

  eventLogEntries.unshift({
    ts: now,
    time: formatEventTime(now),
    message,
    kind,
    agentName,
    source: "client",
    meta: meta || null,
  });
  if (eventLogEntries.length > EVENT_LOG_LIMIT) {
    eventLogEntries.length = EVENT_LOG_LIMIT;
  }

  enqueueEventForPersistence({
    ts: new Date(now).toISOString(),
    clientTs: now,
    kind,
    message,
    agentName,
    dedupeKey: dedupeKey || null,
    source: "client",
    meta,
  });

  eventLogLastMarkup = "";
  renderEventLog();
}

// ---- Canvas Setup ----

const canvas = document.getElementById("grid-canvas");
const ctx = canvas.getContext("2d");

function resize() {
  const wrap = document.getElementById("canvas-wrap");
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  // Give them a much larger area to roam around in (using a fixed scale for chunky pixels)
  // We'll treat the internal canvas resolution as half the screen size, giving a 2x pixel scaling
  const pixelScale = 2;
  canvas.width = Math.floor(w / pixelScale);
  canvas.height = Math.floor(h / pixelScale);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  resetPixelWorld();
}

// ---- Placeholder Sprite Generator ----

function generatePlaceholderSprite(agent) {
  const key = agent.name + ":" + agent.state;
  if (placeholderSprites[key]) return placeholderSprites[key];

  const c = document.createElement("canvas");
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  const sctx = c.getContext("2d");

  let hash = 0;
  for (let i = 0; i < agent.name.length; i++) {
    hash = ((hash << 5) - hash + agent.name.charCodeAt(i)) | 0;
  }

  const typeColor = TYPE_COLORS[agent.type] || "#7eb8f6";

  // Background removed for transparency
  // sctx.fillStyle = "#0b0e14";
  // sctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);

  // Body
  sctx.fillStyle = typeColor;
  const bodyW = 12 + (Math.abs(hash) % 8);
  const bodyH = 10 + (Math.abs(hash >> 4) % 8);
  const bx = Math.floor((SPRITE_SIZE - bodyW) / 2);
  const by = Math.floor((SPRITE_SIZE - bodyH) / 2) + 2;

  sctx.fillRect(bx + 2, by, bodyW - 4, bodyH);
  sctx.fillRect(bx, by + 2, bodyW, bodyH - 4);
  sctx.fillRect(bx + 1, by + 1, bodyW - 2, bodyH - 2);

  // Eyes
  sctx.fillStyle = "#000000";
  const eyeY = by + Math.floor(bodyH * 0.35);
  const eyeSpacing = Math.floor(bodyW * 0.3);
  const cx = Math.floor(SPRITE_SIZE / 2);
  sctx.fillRect(cx - eyeSpacing, eyeY, 2, 2);
  sctx.fillRect(cx + eyeSpacing - 2, eyeY, 2, 2);

  // State indicator dot
  const stateColor = STATE_COLORS[agent.state] || STATE_COLORS.healthy;
  sctx.fillStyle = stateColor;
  const dotX = bx + bodyW + 1;
  const dotY = by;
  if (agent.state === "working" || agent.state === "sick") {
    sctx.fillRect(dotX, dotY, 4, 4);
  } else {
    sctx.fillRect(dotX, dotY + 1, 3, 3);
  }

  // Sick: add X over body
  if (agent.state === "sick") {
    sctx.fillStyle = STATE_COLORS.sick;
    for (let i = 0; i < 4; i++) {
      sctx.fillRect(bx + 2 + i * 2, by + 2 + i * 2, 2, 2);
      sctx.fillRect(bx + bodyW - 4 - i * 2, by + 2 + i * 2, 2, 2);
    }
  }

  placeholderSprites[key] = c;
  return c;
}

// ---- Data Fetching ----

function buildDjFallbackAgent() {
  return {
    name: DJ_AGENT_NAME,
    role: DJ_AGENT_NAME,
    tagline: "Obsessive music nerd.",
    type: "production",
    state: "healthy",
    bubble: "...",
    schedule: "",
    executionTier: "none",
    lastRun: null,
  };
}

function ensureDjAgentInRoster(roster) {
  if (!Array.isArray(roster)) return [buildDjFallbackAgent()];
  const hasDj = roster.some((agent) => String(agent?.name || "").trim().toLowerCase() === DJ_AGENT_NAME);
  if (hasDj) return roster;
  return [...roster, buildDjFallbackAgent()];
}

async function fetchRoster() {
  try {
    const res = await fetch("/dex/agents");
    if (!res.ok) throw new Error(`${res.status}`);
    const data = ensureDjAgentInRoster(await res.json());
    if (Array.isArray(data) && data.length > 0) {
      // Detect state changes for flash effect
      for (const newAgent of data) {
        const old = agents.find((a) => a.name === newAgent.name);
        if (old) {
          if (old.state !== newAgent.state) {
            newAgent._stateChanged = Date.now();
            logAgentEvent(
              `${newAgent.name} state ${old.state} -> ${newAgent.state}`,
              {
                agentName: newAgent.name,
                kind: "state",
                dedupeKey: `state:${newAgent.name}:${newAgent.state}`,
                cooldownMs: 2600,
              }
            );
          }
          if (old.lastRun !== newAgent.lastRun && newAgent.lastRun) {
            newAgent._justRan = Date.now();
            logAgentEvent(
              `${newAgent.name} completed a run`,
              {
                agentName: newAgent.name,
                kind: "run",
                dedupeKey: `run:${newAgent.name}:${newAgent.lastRun}`,
                cooldownMs: 1200,
              }
            );
          }
          
          // Preserve physical state for aquarium
          newAgent.pos = old.pos;
          newAgent.vel = old.vel;
          newAgent.target = old.target;
          newAgent.facing = old.facing;
          newAgent.action = old.action;
          newAgent.actionTimer = old.actionTimer;
          newAgent.moveSpeed = old.moveSpeed;
          newAgent._facingLockMs = old._facingLockMs;
          if (old.targetAgent?.name) {
            newAgent._targetAgentName = old.targetAgent.name;
          }
        }
      }
      agents = data;
      const agentByName = new Map(agents.map((agent) => [agent.name, agent]));
      for (const rosterAgent of agents) {
        if (rosterAgent._targetAgentName) {
          rosterAgent.targetAgent = agentByName.get(rosterAgent._targetAgentName) || null;
          delete rosterAgent._targetAgentName;
        } else if (!rosterAgent.targetAgent) {
          rosterAgent.targetAgent = null;
        }
      }
      placeholderSprites = {};
      primeRosterSprites();
      for (const rosterAgent of agents) {
        if (!agentModelFetchState[rosterAgent.name]) {
          fetchAgentModelInfo(rosterAgent.name);
        }
      }
      reconcileSelectedAgentVisibility();
      renderSettingsAgentToggles();
      syncDjUiState();
      if (view === "campfire") {
        refreshCampfireAgentButtons();
        updateCampfireSession();
      }
    }
  } catch (e) {
    console.warn("[dex] Failed to fetch roster:", e.message);
    if (agents.length === 0) {
      agents = ensureDjAgentInRoster(generateFallbackRoster());
      primeRosterSprites();
      reconcileSelectedAgentVisibility();
      renderSettingsAgentToggles();
      syncDjUiState();
    }
  }
}

async function fetchProfile(name) {
  try {
    const res = await fetch(`/dex/agents/${name}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("[dex] Failed to fetch profile:", e.message);
    return null;
  }
}

function generateFallbackRoster() {
  const names = [
    { name: "sentinel", type: "infrastructure", tagline: "The Watchkeeper." },
    { name: "protector", type: "infrastructure", tagline: "Guardian of the perimeter." },
    { name: "treasurer", type: "infrastructure", tagline: "Counts every token." },
    { name: "dreamer", type: "creative", tagline: "Connects ideas." },
    { name: "coder", type: "creative", tagline: "Ships code." },
    { name: "scribe", type: "creative", tagline: "Writes the record." },
    { name: "observer", type: "creative", tagline: "Notices patterns." },
    { name: "director", type: "production", tagline: "Cuts footage." },
    { name: "composer", type: "production", tagline: "Builds soundscapes." },
    { name: "photoblogger", type: "production", tagline: "Curates the visual record." },
    { name: "vitals", type: "embodied", tagline: "Reads the body." },
    { name: "eros", type: "embodied", tagline: "Sensation as architecture." },
    { name: DJ_AGENT_NAME, type: "production", tagline: "Obsessive music nerd." },
  ];
  return names.map((n) => ({
    ...n,
    role: n.name,
    state: "healthy",
    bubble: "...",
    schedule: "",
    executionTier: "none",
    lastRun: null,
  }));
}

function loadSpriteForAgent(name) {
  if (!name) return;
  if (spriteImages[name]) return;
  const status = spriteLoadState[name];
  if (status === "loading" || status === "loaded" || status === "error") return;

  spriteLoadState[name] = "loading";
  const image = new Image();
  image.onload = () => {
    spriteImages[name] = image;
    spriteLoadState[name] = "loaded";
  };
  image.onerror = () => {
    spriteLoadState[name] = "error";
  };
  image.src = `/sprites/${encodeURIComponent(name)}.svg`;
}

function loadModelIconBySrc(src) {
  if (!src) return;
  if (modelIconImages[src]) return;
  const status = modelIconLoadState[src];
  if (status === "loading" || status === "loaded" || status === "error") return;

  modelIconLoadState[src] = "loading";
  const image = new Image();
  image.onload = () => {
    modelIconImages[src] = image;
    modelIconLoadState[src] = "loaded";
  };
  image.onerror = () => {
    modelIconLoadState[src] = "error";
  };
  image.src = src;
}

function primeModelIcons() {
  for (const entry of MODEL_REGISTRY) {
    const iconPath = normalizeAssetPath(entry.icon);
    if (iconPath) loadModelIconBySrc(iconPath);
  }
}

function primeRosterSprites() {
  for (const agent of agents) {
    loadSpriteForAgent(agent.name);
  }
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value | 0));
}

function hash2d(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

function distanceToSegmentSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) return apx * apx + apy * apy;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function resolvePctOrPx(value, size, fallback) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  if (value >= 0 && value <= 1) return Math.floor(value * size);
  return Math.floor(value);
}

function resolveCoord(pxValue, pctValue, size, fallback) {
  if (typeof pxValue === "number" && Number.isFinite(pxValue)) return Math.floor(pxValue);
  return resolvePctOrPx(pctValue, size, fallback);
}

function buildInteractionPoints(layout, w, h, centerX, centerY, radiusX, radiusY) {
  const configured = Array.isArray(layout?.interactionNodes) ? layout.interactionNodes : [];
  if (configured.length > 0) {
    return configured.map((node, i) => {
      const fallbackX = Math.floor(centerX + Math.cos((i / configured.length) * Math.PI * 2) * radiusX * 0.5);
      const fallbackY = Math.floor(centerY + Math.sin((i / configured.length) * Math.PI * 2) * radiusY * 0.45);
      return {
        id: typeof node.id === "string" ? node.id : `node_${i}`,
        x: resolveCoord(node.x, node.xPct, w, fallbackX),
        y: resolveCoord(node.y, node.yPct, h, fallbackY),
        radius: Math.max(6, Math.floor(typeof node.radius === "number" ? node.radius : 12 + (i % 3) * 3)),
        speed: typeof node.speed === "number" ? node.speed : 0.9 + i * 0.08,
        phase: typeof node.phase === "number" ? node.phase : i * 0.7,
        group: i,
      };
    });
  }

  const points = [];
  const ringCount = 8;
  for (let i = 0; i < ringCount; i++) {
    const angle = (i / ringCount) * Math.PI * 2;
    const radial = 0.44 + (i % 3) * 0.11;
    const px = Math.floor(centerX + Math.cos(angle) * radiusX * radial);
    const py = Math.floor(centerY + Math.sin(angle) * radiusY * (0.4 + (i % 2) * 0.09));
    points.push({
      id: `ring_${i}`,
      x: px,
      y: py,
      radius: 12 + (i % 3) * 3,
      speed: 0.9 + i * 0.08,
      phase: i * 0.7,
      group: i,
    });
  }
  points.push({
    id: "core_hub",
    x: centerX,
    y: centerY,
    radius: 18,
    speed: 1.35,
    phase: 4.7,
    group: ringCount,
  });
  return points;
}

function buildBoundarySegments(points, layout) {
  const segments = [];
  if (points.length < 2) return segments;

  const byId = new Map(points.map((point) => [point.id, point]));
  const configuredLinks = Array.isArray(layout?.boundaryLinks) ? layout.boundaryLinks : [];
  for (const link of configuredLinks) {
    if (!Array.isArray(link) || link.length < 2) continue;
    const a = byId.get(link[0]);
    const b = byId.get(link[1]);
    if (a && b) segments.push([a, b]);
  }
  if (segments.length > 0) return segments;

  const center = points.find((p) => p.id === "core_hub") || points[points.length - 1];
  const ring = points.filter((point) => point !== center);
  const ringCount = ring.length;
  for (let i = 0; i < ringCount; i++) {
    const current = ring[i];
    const next = ring[(i + 1) % ringCount];
    segments.push([current, next]);
    segments.push([current, center]);
  }
  return segments;
}

function createPixelField(w, h) {
  const core = WORLD_LAYOUT.core || {};
  const terrain = WORLD_LAYOUT.terrain || {};
  const zoneThresholds = WORLD_LAYOUT.zoneThresholds || {};

  const centerX = resolveCoord(core.x, core.xPct, w, Math.floor(w * 0.5));
  const centerY = resolveCoord(core.y, core.yPct, h, Math.floor(h * 0.44));
  const radiusX = Math.max(16, resolveCoord(core.radiusX, core.radiusXPct, w, Math.floor(w * 0.36)));
  const radiusY = Math.max(16, resolveCoord(core.radiusY, core.radiusYPct, h, Math.floor(h * 0.33)));
  const groundY = Math.max(0, Math.min(h - 1, resolvePctOrPx(terrain.baselinePct, h, Math.floor(h * 0.8))));
  const floorWaveAmp = typeof terrain.waveAmp === "number" ? terrain.waveAmp : 3;
  const floorWaveFreq = typeof terrain.waveFreq === "number" ? terrain.waveFreq : 0.05;
  const boundaryOuter = typeof zoneThresholds.boundaryOuter === "number" ? zoneThresholds.boundaryOuter : 1.12;
  const boundaryInner = typeof zoneThresholds.boundaryInner === "number" ? zoneThresholds.boundaryInner : 1.0;
  const coreInner = typeof zoneThresholds.coreInner === "number" ? zoneThresholds.coreInner : 0.42;
  const boundaryLineWidthSq = typeof zoneThresholds.boundaryLineWidthSq === "number"
    ? zoneThresholds.boundaryLineWidthSq
    : 4;
  const interactionPoints = buildInteractionPoints(WORLD_LAYOUT, w, h, centerX, centerY, radiusX, radiusY);
  const boundarySegments = buildBoundarySegments(interactionPoints, WORLD_LAYOUT);
  const size = w * h;
  const zoneMap = new Uint8Array(size);
  const groupMap = new Uint8Array(size);
  const noiseMap = new Uint8Array(size);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const noise = hash2d(x, y, 17) & 0xff;
      noiseMap[idx] = noise;

      let zone = PIXEL_ZONE.VOID;
      const floorWave = Math.sin(x * floorWaveFreq) * floorWaveAmp;
      if (y >= groundY + floorWave) {
        zone = PIXEL_ZONE.TERRAIN;
      } else {
        const nx = (x - centerX) / radiusX;
        const ny = (y - centerY) / radiusY;
        const ellipseDist = nx * nx + ny * ny;
        if (ellipseDist <= boundaryOuter) {
          if (ellipseDist > boundaryInner) zone = PIXEL_ZONE.BOUNDARY;
          else if (ellipseDist < coreInner) zone = PIXEL_ZONE.CORE;
          else zone = PIXEL_ZONE.ATMOSPHERE;
        }
      }

      let nearestIndex = 0;
      let nearestDistSq = Number.POSITIVE_INFINITY;
      for (let i = 0; i < interactionPoints.length; i++) {
        const p = interactionPoints[i];
        const dx = x - p.x;
        const dy = y - p.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq;
          nearestIndex = i;
        }
      }
      groupMap[idx] = nearestIndex;

      if (zone !== PIXEL_ZONE.VOID && zone !== PIXEL_ZONE.TERRAIN) {
        const nearest = interactionPoints[nearestIndex];
        if (nearestDistSq <= nearest.radius * nearest.radius) {
          zone = PIXEL_ZONE.INTERACTION;
        } else if (zone !== PIXEL_ZONE.BOUNDARY) {
          for (const [a, b] of boundarySegments) {
            const lineDistSq = distanceToSegmentSq(x, y, a.x, a.y, b.x, b.y);
            if (lineDistSq <= boundaryLineWidthSq) {
              if ((noise & 7) <= 5) zone = PIXEL_ZONE.BOUNDARY;
              break;
            }
          }
        }
      }

      zoneMap[idx] = zone;
    }
  }

  return {
    width: w,
    height: h,
    centerX,
    centerY,
    radiusX,
    radiusY,
    zoneMap,
    groupMap,
    noiseMap,
    interactionPoints,
    boundarySegments,
    frame: ctx.createImageData(w, h),
  };
}

function ensurePixelField(w, h) {
  if (!pixelField || pixelField.width !== w || pixelField.height !== h) {
    pixelField = createPixelField(w, h);
    worldInteractionPoints = pixelField.interactionPoints;
  }
}

function resetPixelWorld() {
  pixelField = null;
  worldInteractionPoints = [];
}

function cloneJson(data) {
  if (typeof structuredClone === "function") return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
}

function replaceWorldLayout(nextLayout) {
  if (!nextLayout || typeof nextLayout !== "object" || Array.isArray(nextLayout)) {
    throw new Error("Layout must be a JSON object.");
  }
  const cloned = cloneJson(nextLayout);
  for (const key of Object.keys(WORLD_LAYOUT)) {
    delete WORLD_LAYOUT[key];
  }
  Object.assign(WORLD_LAYOUT, cloned);
  resetPixelWorld();
}

function setWorldLayoutStatus(message, kind = "ok") {
  const status = document.getElementById("world-layout-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function refreshWorldLayoutEditor() {
  const input = document.getElementById("world-layout-json");
  if (!input) return;
  input.value = JSON.stringify(WORLD_LAYOUT, null, 2);
}

function toggleWorldMenu(forceOpen) {
  const root = document.getElementById("world-menu");
  const panel = document.getElementById("world-menu-panel");
  const toggle = document.getElementById("world-menu-toggle");
  if (!root || !panel || !toggle) return;

  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !worldMenuOpen;
  worldMenuOpen = shouldOpen;
  root.classList.toggle("open", worldMenuOpen);
  panel.hidden = !worldMenuOpen;
  toggle.setAttribute("aria-expanded", worldMenuOpen ? "true" : "false");

  if (worldMenuOpen) {
    refreshWorldLayoutEditor();
    setWorldLayoutStatus("World editor open.");
  }
}

function applyWorldLayoutFromEditor() {
  const input = document.getElementById("world-layout-json");
  if (!input) return;
  try {
    const parsed = JSON.parse(input.value);
    replaceWorldLayout(parsed);
    refreshWorldLayoutEditor();
    setWorldLayoutStatus("Applied and rebuilt.");
  } catch (error) {
    setWorldLayoutStatus(`Invalid JSON: ${error.message}`, "error");
  }
}

async function copyWorldLayoutFromEditor() {
  const input = document.getElementById("world-layout-json");
  if (!input) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(input.value);
      setWorldLayoutStatus("Copied layout JSON.");
      return;
    }
  } catch {
    // fallback below
  }

  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  setWorldLayoutStatus(copied ? "Copied layout JSON." : "Copy failed.", copied ? "ok" : "error");
}

function resetWorldLayoutToDefault() {
  replaceWorldLayout(DEFAULT_WORLD_LAYOUT);
  refreshWorldLayoutEditor();
  setWorldLayoutStatus("Reset to default world.");
}

function initWorldMenu() {
  const root = document.getElementById("world-menu");
  const panel = document.getElementById("world-menu-panel");
  const toggle = document.getElementById("world-menu-toggle");
  const applyBtn = document.getElementById("world-layout-apply");
  const rebuildBtn = document.getElementById("world-layout-rebuild");
  const copyBtn = document.getElementById("world-layout-copy");
  const resetBtn = document.getElementById("world-layout-reset");
  const input = document.getElementById("world-layout-json");

  if (!root || !panel || !toggle || !applyBtn || !rebuildBtn || !copyBtn || !resetBtn || !input) return;

  refreshWorldLayoutEditor();
  panel.hidden = true;

  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleWorldMenu();
  });

  panel.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  applyBtn.addEventListener("click", () => {
    applyWorldLayoutFromEditor();
  });
  rebuildBtn.addEventListener("click", () => {
    resetPixelWorld();
    setWorldLayoutStatus("Rebuilt current world.");
  });
  copyBtn.addEventListener("click", () => {
    copyWorldLayoutFromEditor();
  });
  resetBtn.addEventListener("click", () => {
    resetWorldLayoutToDefault();
  });

  input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      applyWorldLayoutFromEditor();
    }
  });

  document.addEventListener("click", (event) => {
    if (!worldMenuOpen) return;
    const target = event.target;
    if (target instanceof Node && !root.contains(target)) {
      toggleWorldMenu(false);
    }
  });
}

function exposeWorldControls() {
  if (typeof window === "undefined") return;
  window.DEX_WORLD_LAYOUT = WORLD_LAYOUT;
  window.rebuildDexWorld = resetPixelWorld;
  window.toggleDexWorldMenu = toggleWorldMenu;
}

function normalizeCampfireLabel(value) {
  if (typeof value !== "string") return DEFAULT_CAMPFIRE_LABEL;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || DEFAULT_CAMPFIRE_LABEL;
}

function getCampfireSessionToken() {
  const token = normalizeCampfireLabel(campfireLabel)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || "session";
}

function isAgentVisibleName(name) {
  if (!name) return true;
  return !hiddenAgentNames.has(String(name).trim().toLowerCase());
}

function getVisibleAgents() {
  return agents.filter((agent) => isAgentVisibleName(agent.name));
}

function pruneCampfireSelectionToVisible() {
  if (!campfireSelected || campfireSelected.size === 0) return false;
  const visibleNames = new Set(getVisibleAgents().map((agent) => agent.name));
  const next = new Set();
  for (const name of campfireSelected) {
    if (visibleNames.has(name)) next.add(name);
  }
  const changed = next.size !== campfireSelected.size;
  campfireSelected = next;
  return changed;
}

function reconcileSelectedAgentVisibility() {
  pruneCampfireSelectionToVisible();
  const sortedVisible = getDepthSortedAgents();
  if (sortedVisible.length === 0) {
    selectedIndex = 0;
    bubbleIndex = 0;
  } else {
    const hasSelected = sortedVisible.some((entry) => entry.originalIndex === selectedIndex);
    if (!hasSelected) {
      selectedIndex = sortedVisible[0].originalIndex;
    }
    if (bubbleIndex < 0 || bubbleIndex >= sortedVisible.length) {
      bubbleIndex = 0;
    }
  }

  if (agentMenuOpen && agentMenuAgentName && !isAgentVisibleName(agentMenuAgentName)) {
    closeAgentMenu();
  }
  if (agentProfileWindowOpen && agentProfileWindowAgentName && !isAgentVisibleName(agentProfileWindowAgentName)) {
    closeAgentProfileWindow();
  }
  if (profileAgent?.name && !isAgentVisibleName(profileAgent.name)) {
    hideProfile();
  }
  if (activeBubbleAgentName && !isAgentVisibleName(activeBubbleAgentName)) {
    activeBubbleAgentName = "";
    activeBubbleText = "";
  }
}

const TRACE_STORAGE_KEY = "cosmania-dex-traces";

function saveTraceHistory() {
  try {
    if (typeof localStorage === "undefined") return;
    // Only save tool call data, not full result data (keep it small)
    const slim = {};
    for (const [agent, calls] of Object.entries(traceHistory)) {
      if (calls.length > 0) {
        slim[agent] = calls.slice(-50); // keep last 50 per agent
      }
    }
    localStorage.setItem(TRACE_STORAGE_KEY, JSON.stringify(slim));
  } catch {
    // best effort
  }
}

function loadTraceHistory() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(TRACE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [agent, calls] of Object.entries(parsed)) {
      if (Array.isArray(calls) && calls.length > 0) {
        traceHistory[agent] = calls;
      }
    }
  } catch {
    // best effort
  }
}

function saveUiSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        hiddenAgentNames: Array.from(hiddenAgentNames),
        campfireLabel: normalizeCampfireLabel(campfireLabel),
      })
    );
  } catch {
    // best effort only
  }
}

function loadUiSettings() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.hiddenAgentNames)) {
      hiddenAgentNames = new Set(
        parsed.hiddenAgentNames
          .map((name) => String(name || "").trim().toLowerCase())
          .filter(Boolean)
      );
    }
    if (typeof parsed?.campfireLabel === "string") {
      const normalizedLabel = normalizeCampfireLabel(parsed.campfireLabel);
      campfireLabel = /^campfire$/i.test(normalizedLabel) ? DEFAULT_CAMPFIRE_LABEL : normalizedLabel;
    }
  } catch {
    hiddenAgentNames = hiddenAgentNames || new Set();
    campfireLabel = campfireLabel || DEFAULT_CAMPFIRE_LABEL;
  }
}

function applyCampfireLabelToUi(syncInput = true) {
  const title = document.getElementById("campfire-title");
  if (title) title.textContent = normalizeCampfireLabel(campfireLabel).toUpperCase();

  const hint = document.getElementById("profile-campfire-hint-label");
  if (hint) hint.textContent = normalizeCampfireLabel(campfireLabel).toLowerCase();

  const input = document.getElementById("campfire-input");
  if (input) input.placeholder = `say something to ${normalizeCampfireLabel(campfireLabel).toLowerCase()}...`;

  const settingsInput = document.getElementById("settings-campfire-name");
  if (syncInput && settingsInput) settingsInput.value = normalizeCampfireLabel(campfireLabel);

  updateCampfireSession();
}

function renderSettingsAgentToggles() {
  const list = document.getElementById("settings-agent-list");
  if (!list) return;

  if (!agents.length) {
    list.innerHTML = '<div class="settings-agent-empty">loading roster...</div>';
    return;
  }

  list.innerHTML = "";
  for (const agent of agents) {
    const row = document.createElement("label");
    row.className = "settings-agent-row";
    row.dataset.type = agent.type || "";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = isAgentVisibleName(agent.name);
    check.setAttribute("aria-label", `Toggle ${agent.name} visibility`);
    check.addEventListener("change", () => {
      setAgentVisibility(agent.name, check.checked);
    });

    const name = document.createElement("span");
    name.className = "settings-agent-name";
    name.textContent = agent.name;

    const type = document.createElement("span");
    type.className = "settings-agent-type";
    type.textContent = agent.type || "agent";
    type.dataset.type = agent.type || "";

    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(type);
    list.appendChild(row);
  }
}

function setAgentVisibility(agentName, visible) {
  const key = String(agentName || "").trim().toLowerCase();
  if (!key) return;

  if (visible) hiddenAgentNames.delete(key);
  else hiddenAgentNames.add(key);

  reconcileSelectedAgentVisibility();
  saveUiSettings();
  renderSettingsAgentToggles();
  if (view === "campfire") {
    refreshCampfireAgentButtons();
    updateCampfireSession();
    renderCampfireMessages();
  }
}

function toggleSettingsMenu(forceOpen) {
  const root = document.getElementById("settings-menu");
  const panel = document.getElementById("settings-menu-panel");
  const toggle = document.getElementById("settings-menu-toggle");
  if (!root || !panel || !toggle) return;

  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !settingsMenuOpen;
  settingsMenuOpen = shouldOpen;
  root.classList.toggle("open", settingsMenuOpen);
  panel.hidden = !settingsMenuOpen;
  toggle.setAttribute("aria-expanded", settingsMenuOpen ? "true" : "false");

  if (settingsMenuOpen) {
    if (worldMenuOpen) toggleWorldMenu(false);
    renderSettingsAgentToggles();
    applyCampfireLabelToUi(true);
  }
}

function initSettingsMenu() {
  const root = document.getElementById("settings-menu");
  const panel = document.getElementById("settings-menu-panel");
  const toggle = document.getElementById("settings-menu-toggle");
  const campfireInput = document.getElementById("settings-campfire-name");
  const allOnBtn = document.getElementById("settings-enable-all");
  const allOffBtn = document.getElementById("settings-disable-all");
  if (!root || !panel || !toggle || !campfireInput || !allOnBtn || !allOffBtn) return;

  panel.hidden = true;
  renderSettingsAgentToggles();
  applyCampfireLabelToUi(true);

  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleSettingsMenu();
  });

  panel.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  campfireInput.addEventListener("input", () => {
    const next = campfireInput.value.replace(/\s+/g, " ").trim();
    if (!next) return;
    campfireLabel = normalizeCampfireLabel(next);
    saveUiSettings();
    applyCampfireLabelToUi(false);
  });

  campfireInput.addEventListener("change", () => {
    campfireLabel = normalizeCampfireLabel(campfireInput.value);
    saveUiSettings();
    applyCampfireLabelToUi(true);
  });

  allOnBtn.addEventListener("click", () => {
    hiddenAgentNames.clear();
    reconcileSelectedAgentVisibility();
    saveUiSettings();
    renderSettingsAgentToggles();
    if (view === "campfire") {
      refreshCampfireAgentButtons();
      updateCampfireSession();
      renderCampfireMessages();
    }
  });

  allOffBtn.addEventListener("click", () => {
    hiddenAgentNames = new Set(agents.map((agent) => String(agent.name || "").toLowerCase()).filter(Boolean));
    reconcileSelectedAgentVisibility();
    saveUiSettings();
    renderSettingsAgentToggles();
    if (view === "campfire") {
      refreshCampfireAgentButtons();
      updateCampfireSession();
      renderCampfireMessages();
    }
  });

  document.addEventListener("click", (event) => {
    if (!settingsMenuOpen) return;
    const target = event.target;
    if (target instanceof Node && !root.contains(target)) {
      toggleSettingsMenu(false);
    }
  });
}

function getDepthSortedAgents() {
  return agents
    .map((agent, originalIndex) => ({ agent, originalIndex }))
    .filter(({ agent }) => isAgentVisibleName(agent.name))
    .sort((a, b) => (a.agent.pos?.y || 0) - (b.agent.pos?.y || 0));
}

function clientPointToCanvas(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = ((clientX - rect.left) / rect.width) * canvas.width;
  const y = ((clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function findAgentAtCanvasPoint(canvasX, canvasY) {
  const sortedAgents = getDepthSortedAgents();
  for (let i = sortedAgents.length - 1; i >= 0; i--) {
    const { agent, originalIndex } = sortedAgents[i];
    if (!agent.pos) continue;
    const pad = 6;
    const left = agent.pos.x - SPRITE_DISPLAY / 2 - pad;
    const top = agent.pos.y - SPRITE_DISPLAY / 2 - pad;
    const right = left + SPRITE_DISPLAY + pad * 2;
    const bottom = top + SPRITE_DISPLAY + pad * 2;

    if (canvasX >= left && canvasX <= right && canvasY >= top && canvasY <= bottom) {
      return { agent, originalIndex };
    }
  }
  return null;
}

function getAgentByName(name) {
  if (!name) return null;
  const needle = String(name).trim().toLowerCase();
  if (!needle) return null;
  return agents.find((agent) => agent.name.toLowerCase() === needle) || null;
}

function getAgentAnchorClient(agent) {
  if (!agent || !agent.pos) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;

  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  return {
    x: rect.left + (agent.pos.x + SPRITE_DISPLAY * 0.45) * scaleX,
    y: rect.top + (agent.pos.y - SPRITE_DISPLAY * 0.22) * scaleY,
  };
}

function truncateText(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + "...";
}

function toPreviewText(value, maxChars = 220) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncateText(value, maxChars);
  try {
    const encoded = JSON.stringify(value);
    return encoded ? truncateText(encoded, maxChars) : null;
  } catch {
    return "[unserializable]";
  }
}

function resolveEventAgentName(entry) {
  if (!entry || typeof entry !== "object") return null;

  if (entry.agentName && getAgentByName(entry.agentName)) {
    return entry.agentName;
  }

  if (typeof entry.message === "string") {
    const directPrefix = entry.message.match(/^([a-z0-9_-]{2,40})\b/i);
    if (directPrefix?.[1]) {
      const candidate = directPrefix[1].toLowerCase();
      if (getAgentByName(candidate)) return candidate;
    }
  }

  return null;
}

function updateChatInputContextUI() {
  const input = document.getElementById("chat-input");
  if (input) {
    if (activeChatEventContext && profileAgent && activeChatEventContext.agentName === profileAgent.name) {
      input.placeholder = `continue from ${activeChatEventContext.time} ${activeChatEventContext.kind}...`;
    } else {
      input.placeholder = CHAT_INPUT_DEFAULT_PLACEHOLDER;
    }
  }

  const chatLabel = document.getElementById("chat-agent-label");
  if (chatLabel && profileAgent) {
    const hasContext = Boolean(
      activeChatEventContext && activeChatEventContext.agentName === profileAgent.name
    );
    chatLabel.textContent = hasContext
      ? `${profileAgent.name} · ref ${activeChatEventContext.time}`
      : profileAgent.name;
    chatLabel.style.color = TYPE_COLORS[profileAgent.type] || "var(--fg-muted)";
  }
}

function clearActiveChatEventContext() {
  activeChatEventContext = null;
  updateChatInputContextUI();
}

function setActiveChatEventContext(context) {
  if (!context) {
    clearActiveChatEventContext();
    return;
  }
  activeChatEventContext = {
    agentName: context.agentName,
    time: context.time,
    kind: context.kind,
    message: context.message,
    ts: context.ts,
  };
  updateChatInputContextUI();
}

function buildChatEventReferenceBlock(context) {
  if (!context) return "";
  return [
    "[Event reference context]",
    `time=${context.time}`,
    `kind=${context.kind}`,
    `agent=${context.agentName}`,
    `event=${context.message}`,
  ].join("\n");
}

function startConversationFromEvent(entry) {
  const agentName = resolveEventAgentName(entry);
  if (!agentName) return;
  const agent = getAgentByName(agentName);
  if (!agent) return;

  const anchor = getAgentAnchorClient(agent) || {
    x: Math.round(window.innerWidth * 0.3),
    y: Math.round(window.innerHeight * 0.35),
  };

  showProfile(agent, { asMenu: true, anchor });

  const normalized = toDialogEventText(entry);
  const eventTs = typeof entry.ts === "number" ? entry.ts : Date.now();
  setActiveChatEventContext({
    agentName: agent.name,
    time: entry.time || formatEventTime(eventTs),
    kind: entry.kind || "info",
    message: (typeof entry.message === "string" && entry.message.trim()) ? entry.message.trim() : normalized,
    ts: eventTs,
  });

  const input = document.getElementById("chat-input");
  if (!input) return;
  if (!input.value.trim()) {
    input.value = `follow up on: ${truncateText(normalized, 90)}`;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function isProfilePanelMenuOpen() {
  const panel = document.getElementById("profile-panel");
  return Boolean(profilePanelMenuMode && panel && panel.classList.contains("visible") && panel.classList.contains("menu-mode"));
}

function positionProfilePanelMenu(anchorClientX, anchorClientY) {
  const panel = document.getElementById("profile-panel");
  if (!panel || !panel.classList.contains("menu-mode") || !panel.classList.contains("visible")) return;

  const margin = 8;
  const offset = 16;
  const panelRect = panel.getBoundingClientRect();
  let left = anchorClientX + offset;
  let top = anchorClientY - panelRect.height * 0.42;

  if (left + panelRect.width + margin > window.innerWidth) {
    left = anchorClientX - panelRect.width - offset;
  }

  top = Math.max(margin, Math.min(window.innerHeight - panelRect.height - margin, top));
  left = Math.max(margin, Math.min(window.innerWidth - panelRect.width - margin, left));

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function swapProfileMenuAgent(step) {
  const panel = document.getElementById("profile-panel");
  const profileVisible = Boolean(profileAgent && panel && panel.classList.contains("visible"));
  if (!profileVisible) return;

  const sortedAgents = getDepthSortedAgents().map((entry) => entry.agent);
  if (!sortedAgents.length) return;

  const currentName = profileAgent?.name;
  const currentIndex = currentName
    ? sortedAgents.findIndex((agent) => agent.name === currentName)
    : -1;
  const nextIndex = currentIndex === -1
    ? 0
    : (currentIndex + step + sortedAgents.length) % sortedAgents.length;
  const nextAgent = sortedAgents[nextIndex];
  if (!nextAgent) return;

  const canonicalIndex = agents.findIndex((agent) => agent.name === nextAgent.name);
  if (canonicalIndex >= 0) selectedIndex = canonicalIndex;

  if (isProfilePanelMenuOpen()) {
    const anchor = getAgentAnchorClient(nextAgent) || profilePanelMenuAnchor || {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
    showProfile(nextAgent, { asMenu: true, anchor });
    return;
  }

  if (view === "profile") {
    showProfile(nextAgent, { asMenu: false });
  }
}

function positionAgentMenu(anchorClientX, anchorClientY) {
  const menu = document.getElementById("agent-menu");
  if (!menu || menu.hidden) return;

  const margin = 8;
  const offset = 12;
  const menuRect = menu.getBoundingClientRect();
  let left = anchorClientX + offset;
  let top = anchorClientY - menuRect.height / 2;

  if (left + menuRect.width + margin > window.innerWidth) {
    left = anchorClientX - menuRect.width - offset;
  }

  top = Math.max(margin, Math.min(window.innerHeight - menuRect.height - margin, top));
  left = Math.max(margin, Math.min(window.innerWidth - menuRect.width - margin, left));

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function updateAgentMenuSummary(agent) {
  const bodyEl = document.getElementById("agent-menu-body");
  const modelNameEl = document.getElementById("agent-menu-model-name");
  const modelIconEl = document.getElementById("agent-menu-model-icon");
  if (!bodyEl || !agent) return;
  const runLabel = agent.lastRun ? timeAgo(agent.lastRun) : "never";
  bodyEl.textContent = `${agent.type} | ${agent.state} | run ${runLabel}`;

  if (!modelNameEl || !modelIconEl) return;
  const modelMeta = agentModelInfo[agent.name] || null;
  const fetchState = agentModelFetchState[agent.name];

  if (modelMeta?.modelId) {
    modelNameEl.textContent = getModelDisplayName(modelMeta.modelId);
  } else if (fetchState === "loading") {
    modelNameEl.textContent = "loading...";
  } else if (fetchState === "error") {
    modelNameEl.textContent = "model unavailable";
  } else {
    modelNameEl.textContent = "model ...";
  }

  if (modelMeta?.iconPath) {
    modelIconEl.src = modelMeta.iconPath;
    modelIconEl.hidden = false;
  } else {
    modelIconEl.hidden = true;
    modelIconEl.removeAttribute("src");
  }
}

function openAgentMenu(agent, anchorClientX, anchorClientY) {
  const menu = document.getElementById("agent-menu");
  const nameEl = document.getElementById("agent-menu-name");
  if (!menu || !nameEl) return;

  agentMenuOpen = true;
  agentMenuAgentName = agent.name;
  nameEl.textContent = agent.name;
  updateAgentMenuSummary(agent);
  fetchAgentModelInfo(agent.name).then(() => {
    if (!agentMenuOpen || agentMenuAgentName !== agent.name) return;
    const currentAgent = getAgentByName(agent.name) || agent;
    updateAgentMenuSummary(currentAgent);
  });
  menu.hidden = false;
  const followAnchor = getAgentAnchorClient(agent) || { x: anchorClientX, y: anchorClientY };
  positionAgentMenu(followAnchor.x, followAnchor.y);
  requestAnimationFrame(() => positionAgentMenu(followAnchor.x, followAnchor.y));
}

function closeAgentMenu() {
  const menu = document.getElementById("agent-menu");
  if (!menu) return;
  agentMenuOpen = false;
  agentMenuAgentName = null;
  menu.hidden = true;
}

function positionAgentProfileWindow(anchorClientX, anchorClientY) {
  const panel = document.getElementById("agent-profile-window");
  if (!panel || panel.hidden) return;

  const margin = 8;
  const offset = 14;
  const panelRect = panel.getBoundingClientRect();
  let left = anchorClientX + offset;
  let top = anchorClientY - panelRect.height / 2;

  if (left + panelRect.width + margin > window.innerWidth) {
    left = anchorClientX - panelRect.width - offset;
  }

  top = Math.max(margin, Math.min(window.innerHeight - panelRect.height - margin, top));
  left = Math.max(margin, Math.min(window.innerWidth - panelRect.width - margin, left));

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

function updateAgentProfileWindowContent(agent, details) {
  const nameEl = document.getElementById("agent-profile-window-name");
  const typeEl = document.getElementById("agent-profile-window-type");
  const stateEl = document.getElementById("agent-profile-window-state");
  const tierEl = document.getElementById("agent-profile-window-tier");
  const uptimeEl = document.getElementById("agent-profile-window-uptime");
  const uptimeFill = document.getElementById("agent-profile-window-uptime-fill");
  const runsEl = document.getElementById("agent-profile-window-runs");
  const runsFill = document.getElementById("agent-profile-window-runs-fill");
  const lastRunEl = document.getElementById("agent-profile-window-last-run");
  const costEl = document.getElementById("agent-profile-window-cost");
  const circuitEl = document.getElementById("agent-profile-window-circuit");
  const bubbleEl = document.getElementById("agent-profile-window-bubble");
  if (
    !nameEl ||
    !typeEl ||
    !stateEl ||
    !tierEl ||
    !uptimeEl ||
    !uptimeFill ||
    !runsEl ||
    !runsFill ||
    !lastRunEl ||
    !costEl ||
    !circuitEl ||
    !bubbleEl
  ) {
    return;
  }

  const merged = { ...(details || {}), ...agent };
  const safeState = merged.state || "--";
  const safeType = merged.type || "--";
  const safeTier = merged.executionTier ? String(merged.executionTier).toUpperCase() : "--";
  const uptimePct =
    typeof merged.uptimePct === "number" && Number.isFinite(merged.uptimePct)
      ? Math.max(0, Math.min(100, merged.uptimePct))
      : null;
  const runs24h =
    typeof merged.totalRuns24h === "number" && Number.isFinite(merged.totalRuns24h)
      ? Math.max(0, merged.totalRuns24h)
      : null;
  const runsPct = runs24h === null ? 0 : Math.max(4, Math.min(100, (runs24h / MINI_PROFILE_RUNS_CAP) * 100));
  const rosterBubble = typeof agent.bubble === "string" ? agent.bubble.trim() : "";
  const detailBubble = details && typeof details.bubble === "string" ? details.bubble.trim() : "";
  const bubbleSource =
    rosterBubble && rosterBubble !== "..."
      ? rosterBubble
      : detailBubble || rosterBubble || "...";
  const bubbleText = truncateText(bubbleSource, MINI_PROFILE_BUBBLE_LIMIT);

  nameEl.textContent = merged.name || "unknown";
  typeEl.textContent = safeType;
  typeEl.dataset.type = safeType;
  tierEl.textContent = `TIER ${safeTier}`;
  stateEl.textContent = safeState;
  stateEl.dataset.state = safeState;

  uptimeEl.textContent = uptimePct === null ? "--" : `${Math.round(uptimePct)}%`;
  uptimeFill.style.width = uptimePct === null ? "0%" : `${Math.max(4, Math.round(uptimePct))}%`;
  runsEl.textContent = runs24h === null ? "--" : `${Math.round(runs24h)}/24H`;
  runsFill.style.width = `${runsPct}%`;

  lastRunEl.textContent = merged.lastRun ? `RUN ${timeAgo(merged.lastRun)}` : "RUN NEVER";
  costEl.textContent =
    typeof merged.todayCostUsd === "number" && Number.isFinite(merged.todayCostUsd)
      ? `$${merged.todayCostUsd.toFixed(2)}`
      : "$--";

  if (typeof merged.circuitOpen === "boolean") {
    circuitEl.textContent = merged.circuitOpen ? "CIR OPEN" : "CIR OK";
    circuitEl.dataset.state = merged.circuitOpen ? "open" : "closed";
  } else {
    circuitEl.textContent = "CIR --";
    circuitEl.dataset.state = "";
  }

  bubbleEl.textContent = bubbleText;
}

function openAgentProfileWindow(agent, anchorClientX, anchorClientY) {
  const panel = document.getElementById("agent-profile-window");
  if (!panel) return;

  agentProfileWindowOpen = true;
  agentProfileWindowAgentName = agent.name;
  agentProfileWindowDetails = null;
  agentProfileWindowAnchor = getAgentAnchorClient(agent) || { x: anchorClientX, y: anchorClientY };

  updateAgentProfileWindowContent(agent);
  panel.hidden = false;
  positionAgentProfileWindow(agentProfileWindowAnchor.x, agentProfileWindowAnchor.y);
  requestAnimationFrame(() => {
    if (!agentProfileWindowAnchor) return;
    positionAgentProfileWindow(agentProfileWindowAnchor.x, agentProfileWindowAnchor.y);
  });

  fetchProfile(agent.name).then((details) => {
    if (!details) return;
    if (!agentProfileWindowOpen || agentProfileWindowAgentName !== agent.name) return;
    agentProfileWindowDetails = details;
    const currentAgent = getAgentByName(agent.name) || agent;
    updateAgentProfileWindowContent(currentAgent, details);
  });
}

function closeAgentProfileWindow() {
  const panel = document.getElementById("agent-profile-window");
  if (!panel) return;
  agentProfileWindowOpen = false;
  agentProfileWindowAgentName = null;
  agentProfileWindowAnchor = null;
  agentProfileWindowDetails = null;
  panel.hidden = true;
}

function getAdjacentMiniProfileAgent(step) {
  const sortedAgents = getDepthSortedAgents().map((entry) => entry.agent);
  if (!sortedAgents.length) return null;
  if (!agentProfileWindowAgentName) return sortedAgents[0];

  const currentIndex = sortedAgents.findIndex((agent) => agent.name === agentProfileWindowAgentName);
  if (currentIndex === -1) return sortedAgents[0];

  const nextIndex = (currentIndex + step + sortedAgents.length) % sortedAgents.length;
  return sortedAgents[nextIndex] || null;
}

function swapMiniProfileAgent(step) {
  const nextAgent = getAdjacentMiniProfileAgent(step);
  if (!nextAgent) return;

  const nextIndex = agents.findIndex((agent) => agent.name === nextAgent.name);
  if (nextIndex >= 0) selectedIndex = nextIndex;

  const followAnchor = getAgentAnchorClient(nextAgent) || agentProfileWindowAnchor || {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  };
  openAgentProfileWindow(nextAgent, followAnchor.x, followAnchor.y);
}

function syncFloatingMenusToAgents() {
  if (view !== "grid") return;

  if (agentMenuOpen && agentMenuAgentName) {
    const agent = getAgentByName(agentMenuAgentName);
    if (!agent || !isAgentVisibleName(agent.name)) {
      closeAgentMenu();
    } else {
      updateAgentMenuSummary(agent);
      const anchor = getAgentAnchorClient(agent);
      if (anchor) positionAgentMenu(anchor.x, anchor.y);
    }
  }

  if (agentProfileWindowOpen && agentProfileWindowAgentName) {
    const agent = getAgentByName(agentProfileWindowAgentName);
    if (!agent || !isAgentVisibleName(agent.name)) {
      closeAgentProfileWindow();
    } else {
      const anchor = getAgentAnchorClient(agent);
      if (anchor) {
        agentProfileWindowAnchor = anchor;
        positionAgentProfileWindow(anchor.x, anchor.y);
      }
      updateAgentProfileWindowContent(agent, agentProfileWindowDetails);
    }
  }

  if (isProfilePanelMenuOpen() && profileAgent?.name) {
    const liveAgent = getAgentByName(profileAgent.name);
    if (!liveAgent || !isAgentVisibleName(liveAgent.name)) {
      hideProfile();
      return;
    }

    profileAgent = liveAgent;
    const anchor = getAgentAnchorClient(liveAgent);
    if (anchor) {
      profilePanelMenuAnchor = anchor;
      positionProfilePanelMenu(anchor.x, anchor.y);
    }
  }
}

function handleCanvasClick(event) {
  if (view !== "grid") return;
  const point = clientPointToCanvas(event.clientX, event.clientY);
  if (!point) return;

  const hit = findAgentAtCanvasPoint(point.x, point.y);
  if (!hit) {
    closeAgentMenu();
    closeAgentProfileWindow();
    if (isProfilePanelMenuOpen()) hideProfile();
    return;
  }

  selectedIndex = hit.originalIndex;
  closeAgentProfileWindow();
  if (isProfilePanelMenuOpen()) hideProfile();
  openAgentMenu(hit.agent, event.clientX, event.clientY);
}

function handleCanvasPointerMove(event) {
  if (view !== "grid") {
    canvas.style.cursor = "default";
    return;
  }
  const point = clientPointToCanvas(event.clientX, event.clientY);
  if (!point) return;
  const hit = findAgentAtCanvasPoint(point.x, point.y);
  canvas.style.cursor = hit ? "pointer" : "default";
}

function initAgentMenu() {
  const menu = document.getElementById("agent-menu");
  const profileBtn = document.getElementById("agent-menu-profile");
  const modelBtn = document.getElementById("agent-menu-model");
  const closeBtn = document.getElementById("agent-menu-close");
  if (!menu || !profileBtn || !closeBtn) return;

  menu.hidden = true;

  profileBtn.addEventListener("click", () => {
    if (!agentMenuAgentName) return;
    const agent = getAgentByName(agentMenuAgentName);
    if (!agent) {
      closeAgentMenu();
      return;
    }
    const rect = profileBtn.getBoundingClientRect();
    const anchor = getAgentAnchorClient(agent) || { x: rect.right, y: rect.top + rect.height / 2 };
    closeAgentMenu();
    showProfile(agent, { asMenu: true, anchor });
  });

  if (modelBtn) {
    modelBtn.addEventListener("click", () => {
      if (!agentMenuAgentName) return;
      const agent = getAgentByName(agentMenuAgentName);
      if (!agent) {
        closeAgentMenu();
        return;
      }
      closeAgentMenu();
      openModelPicker(agent.name);
    });
  }

  closeBtn.addEventListener("click", () => {
    closeAgentMenu();
  });

  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.addEventListener("click", (event) => {
    if (!agentMenuOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (target === canvas) return;
    if (!menu.contains(target)) closeAgentMenu();
  });
}

function initAgentProfileWindow() {
  const panel = document.getElementById("agent-profile-window");
  const closeDot = document.getElementById("agent-profile-window-close-dot");
  const closeBtn = document.getElementById("agent-profile-window-close");
  const openFullBtn = document.getElementById("agent-profile-window-open-full");
  const prevBtn = document.getElementById("agent-profile-window-prev");
  const nextBtn = document.getElementById("agent-profile-window-next");
  if (!panel || !closeDot || !closeBtn || !openFullBtn || !prevBtn || !nextBtn) return;

  panel.hidden = true;

  const closeWindow = () => {
    closeAgentProfileWindow();
  };

  closeDot.addEventListener("click", closeWindow);
  closeBtn.addEventListener("click", closeWindow);
  prevBtn.addEventListener("click", () => swapMiniProfileAgent(-1));
  nextBtn.addEventListener("click", () => swapMiniProfileAgent(1));

  openFullBtn.addEventListener("click", () => {
    if (!agentProfileWindowAgentName) return;
    const agent = getAgentByName(agentProfileWindowAgentName);
    if (!agent) {
      closeAgentProfileWindow();
      return;
    }
    closeAgentProfileWindow();
    showProfile(agent);
  });

  panel.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  document.addEventListener("click", (event) => {
    if (!agentProfileWindowOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (!panel.contains(target)) closeAgentProfileWindow();
  });

  window.addEventListener("resize", () => {
    syncFloatingMenusToAgents();
  });
}

function getZoneAt(x, y) {
  if (!pixelField) return PIXEL_ZONE.ATMOSPHERE;
  const ix = Math.max(0, Math.min(pixelField.width - 1, Math.floor(x)));
  const iy = Math.max(0, Math.min(pixelField.height - 1, Math.floor(y)));
  return pixelField.zoneMap[iy * pixelField.width + ix];
}

function isNavigableZone(zone) {
  return zone === PIXEL_ZONE.ATMOSPHERE || zone === PIXEL_ZONE.CORE || zone === PIXEL_ZONE.INTERACTION;
}

function isWalkablePosition(x, y) {
  const centerZone = getZoneAt(x, y);
  const footZone = getZoneAt(x, y + SPRITE_DISPLAY * 0.2);
  return isNavigableZone(centerZone) && isNavigableZone(footZone);
}

function pickIntentionalTarget(preferInteraction = false) {
  ensurePixelField(canvas.width, canvas.height);
  const margin = SPRITE_DISPLAY / 2 + 6;
  const minX = margin;
  const maxX = canvas.width - margin;
  const minY = margin;
  const maxY = canvas.height - margin;

  if (preferInteraction && worldInteractionPoints.length > 0) {
    const preferredIds = Array.isArray(WORLD_LAYOUT.agentTargetNodeIds)
      ? new Set(WORLD_LAYOUT.agentTargetNodeIds)
      : null;
    const preferredPoints = preferredIds
      ? worldInteractionPoints.filter((point) => preferredIds.has(point.id))
      : [];
    const pointPool = preferredPoints.length > 0 ? preferredPoints : worldInteractionPoints;

    for (let attempt = 0; attempt < 26; attempt++) {
      const point = pointPool[Math.floor(Math.random() * pointPool.length)];
      const angle = Math.random() * Math.PI * 2;
      const radius = point.radius + 14 + Math.random() * 24;
      const tx = point.x + Math.cos(angle) * radius;
      const ty = point.y + Math.sin(angle) * radius;
      if (tx >= minX && tx <= maxX && ty >= minY && ty <= maxY && isWalkablePosition(tx, ty)) {
        return { x: tx, y: ty };
      }
    }
  }

  for (let attempt = 0; attempt < 80; attempt++) {
    const tx = minX + Math.random() * (maxX - minX);
    const ty = minY + Math.random() * (maxY - minY);
    if (isWalkablePosition(tx, ty)) return { x: tx, y: ty };
  }

  return { x: canvas.width / 2, y: canvas.height / 2 };
}

function getNearbyInteractionPoint(x, y, maxDist = 24) {
  if (!worldInteractionPoints.length) return null;
  let nearest = null;
  let nearestDistSq = maxDist * maxDist;
  for (const point of worldInteractionPoints) {
    const dx = x - point.x;
    const dy = y - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= nearestDistSq) {
      nearest = point;
      nearestDistSq = distSq;
    }
  }
  return nearest;
}

function steerAgentVelocity(agent, desiredX, desiredY, delta) {
  const frameScale = Math.max(0.6, Math.min(2.2, delta / 16));
  const blend = Math.min(0.9, MOVE_TARGET_BLEND * frameScale);
  agent.vel.x += (desiredX - agent.vel.x) * blend;
  agent.vel.y += (desiredY - agent.vel.y) * blend;
}

function dampAgentVelocity(agent, delta, base = MOVE_IDLE_DAMP) {
  const frameScale = Math.max(0.6, Math.min(2.2, delta / 16));
  const keep = Math.pow(base, frameScale);
  agent.vel.x *= keep;
  agent.vel.y *= keep;
  if (Math.abs(agent.vel.x) < 0.0005) agent.vel.x = 0;
  if (Math.abs(agent.vel.y) < 0.0005) agent.vel.y = 0;
}

function updateFacingFromVelocity(agent, delta = 16) {
  const remainingLock = Number.isFinite(agent._facingLockMs) ? agent._facingLockMs : 0;
  if (remainingLock > 0) {
    agent._facingLockMs = Math.max(0, remainingLock - delta);
    return;
  }
  if (Math.abs(agent.vel.x) > MOVE_FACING_DEADZONE) {
    agent.facing = agent.vel.x > 0 ? 1 : -1;
  }
}

// ---- Aquarium Rendering ----

function updateAquarium(delta) {
  ensurePixelField(canvas.width, canvas.height);
  const margin = SPRITE_DISPLAY / 2;
  const activeAgents = getVisibleAgents();

  for (let i = 0; i < activeAgents.length; i++) {
    const a = activeAgents[i];

    // Init physics state if missing
    if (!a.pos) {
      const spawn = pickIntentionalTarget(true);
      a.pos = {
        x: spawn.x,
        y: spawn.y,
      };
      a.vel = { x: 0, y: 0 };
      a.target = null;
      a.targetAgent = null;
      a.facing = Math.random() > 0.5 ? 1 : -1;
      a.action = "idle";
      a.actionTimer = Math.random() * 2000;
      a.moveSpeed = 0.028 + Math.random() * 0.015;
      a._facingLockMs = 0;
      logAgentEvent(`${a.name} entered the habitat`, {
        agentName: a.name,
        kind: "social",
        dedupeKey: `spawn:${a.name}`,
        cooldownMs: 600000,
      });
    }
    if (!a.vel) a.vel = { x: 0, y: 0 };
    if (!a.moveSpeed) a.moveSpeed = 0.028 + Math.random() * 0.015;
    if (!Number.isFinite(a._facingLockMs)) a._facingLockMs = 0;
    if (a.targetAgent && !isAgentVisibleName(a.targetAgent.name)) {
      a.targetAgent = null;
      if (a.action === "seeking_friend") {
        a.action = "walking";
        a.actionTimer = 2400 + Math.random() * 3200;
        a.target = pickIntentionalTarget(true);
      }
    }
    if ((a.action === "seeking_friend" || a.action === "chatting") && (!a.targetAgent || !a.targetAgent.pos)) {
      a.action = "walking";
      a.actionTimer = 1800 + Math.random() * 2600;
      a.target = pickIntentionalTarget(true);
      a.targetAgent = null;
    }

    // AI State Machine
    a.actionTimer -= delta;
    if (a.actionTimer <= 0) {
      const rand = Math.random();

      if (a.action === "chatting") {
        // Always walk away after chatting to prevent clustering
        const partner = a.targetAgent?.name;
        a.action = "walking";
        a.actionTimer = 3000 + Math.random() * 5000;
        a.target = pickIntentionalTarget(true);
        a.targetAgent = null;
        if (partner) {
          logAgentEvent(`${a.name} wrapped chat with ${partner}`, {
            agentName: a.name,
            kind: "chat",
            dedupeKey: `chat-end:${[a.name, partner].sort().join(":")}`,
            cooldownMs: 5000,
          });
        }
      } else if (a.action === "idle") {
        if (rand < 0.14) {
          // Seek friend
          a.action = "seeking_friend";
          a.actionTimer = 5000 + Math.random() * 5000;
          // Find a random other agent
          const others = activeAgents.filter((other) => other !== a && other.action !== "seeking_friend");
          const friend = others[Math.floor(Math.random() * others.length)];
          if (friend) {
            a.targetAgent = friend;
            a.target = null;
            logAgentEvent(`${a.name} is seeking ${friend.name}`, {
              agentName: a.name,
              kind: "social",
              dedupeKey: `seek:${a.name}:${friend.name}`,
              cooldownMs: 5200,
            });
          } else {
            a.action = "walking";
            a.target = pickIntentionalTarget(true);
          }
        } else if (rand < 0.44) {
          // Move toward intentional interaction points
          a.action = "walking";
          a.actionTimer = 2800 + Math.random() * 5200;
          a.target = pickIntentionalTarget(true);
          a.targetAgent = null;
        } else if (rand < 0.82) {
          // Walk to open navigable area
          a.action = "walking";
          a.actionTimer = 3000 + Math.random() * 6000;
          a.target = pickIntentionalTarget(false);
          a.targetAgent = null;
        } else {
          // Stay idle
          a.action = "idle";
          a.actionTimer = 1000 + Math.random() * 3000;
        }
      } else {
        // Was walking/seeking, now idle
        a.action = "idle";
        a.actionTimer = 1000 + Math.random() * 4000;
        a.vel = { x: 0, y: 0 };
        a.target = null;
        a.targetAgent = null;
      }
    }

    // Movement Logic
    if (a.action === "seeking_friend" && a.targetAgent && a.targetAgent.pos) {
      const dx = a.targetAgent.pos.x - a.pos.x;
      const dy = a.targetAgent.pos.y - a.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 44) {
        const speed = a.moveSpeed + 0.01;
        const desiredX = (dx / dist) * speed;
        const desiredY = (dy / dist) * speed;
        steerAgentVelocity(a, desiredX, desiredY, delta);
        const probeX = a.pos.x + a.vel.x * delta;
        const probeY = a.pos.y + a.vel.y * delta;
        if (!isWalkablePosition(probeX, probeY)) {
          a.action = "walking";
          a.actionTimer = 2400 + Math.random() * 3000;
          a.target = pickIntentionalTarget(true);
          a.targetAgent = null;
          dampAgentVelocity(a, delta, 0.7);
        }
      } else {
        // Reached friend, start chatting
        const partner = a.targetAgent?.name;
        a.action = "chatting";
        a.actionTimer = 3000 + Math.random() * 5000;
        dampAgentVelocity(a, delta, 0.65);
        const faceDx = a.targetAgent.pos.x - a.pos.x;
        if (Math.abs(faceDx) > 1) {
          a.facing = faceDx > 0 ? 1 : -1;
          a.targetAgent.facing = faceDx > 0 ? -1 : 1; // Make them face each other.
          a._facingLockMs = 220;
          a.targetAgent._facingLockMs = 220;
        }
        if (partner) {
          logAgentEvent(`${a.name} started chatting with ${partner}`, {
            agentName: a.name,
            kind: "chat",
            dedupeKey: `chat-start:${[a.name, partner].sort().join(":")}`,
            cooldownMs: 5000,
          });
        }
      }
    } else if (a.action === "walking" && a.target) {
      const dx = a.target.x - a.pos.x;
      const dy = a.target.y - a.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > WALK_ARRIVE_RADIUS) {
        const slowFactor = dist < WALK_SLOW_RADIUS
          ? Math.max(0.35, dist / WALK_SLOW_RADIUS)
          : 1;
        const speed = a.moveSpeed * slowFactor;
        const desiredX = (dx / dist) * speed;
        const desiredY = (dy / dist) * speed;
        steerAgentVelocity(a, desiredX, desiredY, delta);
      } else {
        a.action = "idle";
        a.actionTimer = 900 + Math.random() * 1600;
        a.target = null;
        dampAgentVelocity(a, delta, 0.65);
      }
    } else {
      dampAgentVelocity(a, delta);
    }

    updateFacingFromVelocity(a, delta);

    // Apply velocity
    const nextX = a.pos.x + a.vel.x * delta;
    const nextY = a.pos.y + a.vel.y * delta;
    if (isWalkablePosition(nextX, nextY)) {
      a.pos.x = nextX;
      a.pos.y = nextY;
    } else if (a.action !== "chatting") {
      a.vel.x = 0;
      a.vel.y = 0;
      a.action = "walking";
      a.actionTimer = 2200 + Math.random() * 3200;
      a.target = pickIntentionalTarget(true);
      a.targetAgent = null;
    }

    // Constrain to canvas
    a.pos.x = Math.max(margin, Math.min(canvas.width - margin, a.pos.x));
    a.pos.y = Math.max(margin, Math.min(canvas.height - margin, a.pos.y));
    if (!isWalkablePosition(a.pos.x, a.pos.y)) {
      const safePoint = pickIntentionalTarget(true);
      a.pos.x = safePoint.x;
      a.pos.y = safePoint.y;
      a.vel = { x: 0, y: 0 };
      a.target = safePoint;
      a.action = "walking";
      a.actionTimer = 1800 + Math.random() * 2600;
      a.targetAgent = null;
    }
  }
}

function drawEnvironment(ctx, w, h, timestamp = 0) {
  ensurePixelField(w, h);
  const field = pixelField;
  const data = field.frame.data;
  const zoneMap = field.zoneMap;
  const groupMap = field.groupMap;
  const noiseMap = field.noiseMap;
  const t = timestamp * 0.001;
  const twoPi = Math.PI * 2;

  let ptr = 0;
  for (let y = 0; y < h; y++) {
    const scanline = y % 2 === 0 ? 1.0 : 0.9;
    const yWave = Math.sin(t * 0.9 + y * 0.04) * 0.08;

    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const zone = zoneMap[idx];
      const group = groupMap[idx];
      const grain = noiseMap[idx] / 255;
      const pulse = Math.sin(t * (1.4 + group * 0.03) + grain * twoPi + group * 0.65);
      const shimmer = Math.sin(t * 6.8 + x * 0.11 + y * 0.07 + group * 1.17);
      let r = 0;
      let g = 0;
      let b = 0;

      if (zone === PIXEL_ZONE.VOID) {
        r = 6 + grain * 10;
        g = 10 + grain * 14;
        b = 22 + grain * 34;
        if ((noiseMap[idx] & 63) === 0) {
          const twinkle = 95 + (Math.sin(t * 3.7 + group * 0.8 + grain * 9) * 0.5 + 0.5) * 95;
          r += twinkle * 0.25;
          g += twinkle * 0.45;
          b += twinkle * 0.8;
        }
      } else if (zone === PIXEL_ZONE.ATMOSPHERE) {
        r = 24 + grain * 16 + pulse * 12;
        g = 56 + grain * 32 + pulse * 18;
        b = 140 + grain * 42 + pulse * 26;
      } else if (zone === PIXEL_ZONE.CORE) {
        r = 132 + grain * 32 + pulse * 22 + shimmer * 8;
        g = 186 + grain * 40 + pulse * 18 + shimmer * 10;
        b = 220 + grain * 26 + pulse * 16 + shimmer * 14;
      } else if (zone === PIXEL_ZONE.BOUNDARY) {
        const edgePulse = Math.sin(t * 4.4 + x * 0.08 + y * 0.05 + group * 0.7);
        r = 120 + grain * 20 + edgePulse * 46;
        g = 86 + grain * 18 + edgePulse * 24;
        b = 178 + grain * 28 + edgePulse * 38;
      } else if (zone === PIXEL_ZONE.INTERACTION) {
        const nodePulse = Math.sin(t * (5.5 + group * 0.05) + grain * 10 + group);
        r = 96 + grain * 32 + nodePulse * 34;
        g = 200 + grain * 36 + nodePulse * 28;
        b = 228 + grain * 20 + nodePulse * 24;
      } else {
        const terrainPulse = Math.sin(t * 1.8 + x * 0.05 + group * 0.7);
        r = 18 + grain * 20 + terrainPulse * 8;
        g = 36 + grain * 46 + terrainPulse * 12;
        b = 70 + grain * 30 + terrainPulse * 10;
      }

      const lattice = ((x + y + group) & 1) === 0 ? 1.03 : 0.82;
      const intensity = (1 + yWave + pulse * 0.12) * lattice * scanline;
      data[ptr] = clampByte(r * intensity);
      data[ptr + 1] = clampByte(g * intensity);
      data[ptr + 2] = clampByte(b * intensity);
      data[ptr + 3] = 255;
      ptr += 4;
    }
  }

  ctx.putImageData(field.frame, 0, 0);

  // Interaction and boundary overlays are drawn intentionally to expose world structure.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const point of field.interactionPoints) {
    const pulse = Math.sin(t * point.speed + point.phase) * 0.5 + 0.5;
    const halo = point.radius + 3 + Math.floor(pulse * 3);
    ctx.globalAlpha = 0.06 + pulse * 0.12;
    ctx.fillStyle = "#8ae9ff";
    for (let i = -halo; i <= halo; i += 2) {
      ctx.fillRect(point.x + i, point.y, 1, 1);
      ctx.fillRect(point.x, point.y + i, 1, 1);
    }
    ctx.globalAlpha = 0.5 + pulse * 0.25;
    ctx.fillStyle = "#f3c68f";
    ctx.fillRect(point.x, point.y, 1, 1);
  }

  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#9b6ae4";
  for (const [a, b] of field.boundarySegments) {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let i = 0; i <= steps; i += 3) {
      const tSeg = steps === 0 ? 0 : i / steps;
      const px = Math.floor(a.x + (b.x - a.x) * tSeg);
      const py = Math.floor(a.y + (b.y - a.y) * tSeg);
      ctx.fillRect(px, py, 1, 1);
    }
  }
  ctx.restore();
}

function drawFloatingModelTag(ctx, modelMeta, spriteX, spriteY, spriteSize, timestamp, phase, isSelected) {
  if (!modelMeta?.modelId) return;

  const iconImage = getModelIconImage(modelMeta);
  if (!iconImage && !modelMeta.label) return;

  const orbitRadius = Math.max(3, spriteSize * 0.08);
  const iconSize = Math.max(10, Math.round(spriteSize * 0.22));
  const angle = timestamp * MODEL_ICON_ORBIT_SPEED + phase;
  const bob = Math.sin(timestamp * 0.0031 + phase * 1.7) * (MODEL_ICON_FLOAT_AMPLITUDE * 0.38);
  const anchorX = spriteX + spriteSize * 0.62;
  const anchorY = spriteY + spriteSize * 0.14;
  const iconCenterX = anchorX + Math.cos(angle) * orbitRadius;
  const iconCenterY = anchorY + Math.sin(angle * 1.17) * (orbitRadius * 0.4) + bob;
  const left = Math.floor(iconCenterX - iconSize / 2);
  const top = Math.floor(iconCenterY - iconSize / 2);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = isSelected ? 1 : 0.92;

  if (iconImage) {
    ctx.drawImage(iconImage, left, top, iconSize, iconSize);
  } else if (modelMeta.label) {
    const fallback = modelMeta.label.slice(0, 6);
    ctx.font = "7px 'Departure Mono', 'Noto Emoji', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "#b5ccff";
    ctx.fillText(fallback, left, top + Math.floor((iconSize - 7) / 2));
  }
  ctx.restore();
}

function drawAquarium(timestamp) {
  // Redraw environment every frame before agents
  drawEnvironment(ctx, canvas.width, canvas.height, timestamp);
  
  // Sort agents by Y coordinate for depth sorting
  const sortedAgents = getDepthSortedAgents();
    
  for (const { agent, originalIndex } of sortedAgents) {
    if (!agent.pos) continue;
    
    const isSelected = originalIndex === selectedIndex;
    const x = agent.pos.x - SPRITE_DISPLAY / 2;
    const baseY = agent.pos.y - SPRITE_DISPLAY / 2;
    
    // Bobbing animation
    let yOffset = 0;
    if (agent.state === "working") {
      yOffset = Math.sin(timestamp / 200 + originalIndex * 1.3) * 3;
    } else if (agent.state === "sick") {
      yOffset = (Math.random() - 0.5) * 2;
    } else if (agent.action === 'walking') {
      yOffset = Math.abs(Math.sin(timestamp / 100)) * 4; // Bouncing walk
    } else {
      yOffset = Math.sin(timestamp / 1200 + originalIndex * 0.8) * 1.5;
    }
    
    const drawY = baseY + yOffset;
    
    // State change flash
    if (agent._stateChanged && Date.now() - agent._stateChanged < 2000) {
      const flash = Math.sin((Date.now() - agent._stateChanged) / 100) * 0.5 + 0.5;
      ctx.globalAlpha = flash * 0.4; // Softer glow behind
      ctx.fillStyle = STATE_COLORS[agent.state] || "#fff";
      ctx.beginPath();
      ctx.arc(x + SPRITE_DISPLAY/2, baseY + SPRITE_DISPLAY/2, SPRITE_DISPLAY/2 + 4, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    
    // "Just ran" pulse ring
    if (agent._justRan && Date.now() - agent._justRan < 3000) {
      const age = (Date.now() - agent._justRan) / 3000;
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = STATE_COLORS.healthy;
      ctx.lineWidth = 2;
      const expand = age * 16;
      ctx.beginPath();
      ctx.arc(x + SPRITE_DISPLAY/2, baseY + SPRITE_DISPLAY/2, SPRITE_DISPLAY/2 + expand, 0, Math.PI*2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    
    // Selection highlight
    if (isSelected) {
      const typeColor = TYPE_COLORS[agent.type] || "#7eb8f6";
      ctx.strokeStyle = typeColor;
      ctx.lineWidth = 2;
      
      // Draw an ellipse under the agent for selection
      ctx.beginPath();
      ctx.ellipse(x + SPRITE_DISPLAY/2, baseY + SPRITE_DISPLAY - 10, SPRITE_DISPLAY/2 + 4, 12, 0, 0, Math.PI*2);
      ctx.stroke();
      
      const pulse = Math.sin(timestamp / 400) * 0.3 + 0.7;
      ctx.globalAlpha = pulse * 0.15;
      ctx.fillStyle = typeColor;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    
    // Draw Sprite
    const sprite = spriteImages[agent.name] || generatePlaceholderSprite(agent);
    ctx.imageSmoothingEnabled = false;
    
    ctx.save();
    if (agent.facing === -1) {
      // Flip horizontally around the center of the sprite
      ctx.translate(x + SPRITE_DISPLAY / 2, Math.floor(drawY));
      ctx.scale(-1, 1);
      ctx.translate(-SPRITE_DISPLAY / 2, 0);
      ctx.drawImage(sprite, 0, 0, SPRITE_DISPLAY, SPRITE_DISPLAY);
    } else {
      ctx.drawImage(sprite, x, Math.floor(drawY), SPRITE_DISPLAY, SPRITE_DISPLAY);
    }
    ctx.restore();

    // Selected model badge: model icon floats around the agent head.
    const modelMeta = agentModelInfo[agent.name];
    const modelPhase = originalIndex * 0.83 + agent.name.length * 0.37;
    drawFloatingModelTag(ctx, modelMeta, x, drawY, SPRITE_DISPLAY, timestamp, modelPhase, isSelected);
    
    // Status particles: use pixel tags with pulse + short-lived motion.
    const drawIndicatorTag = (text, centerX, centerY, fg, alpha = 1) => {
      if (!text) return;
      ctx.save();
      ctx.font = "8px 'Departure Mono', 'Noto Emoji', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const tw = Math.ceil(ctx.measureText(text).width);
      const w = tw + 6;
      const h = 9;
      const left = Math.floor(centerX - w / 2);
      const top = Math.floor(centerY - h / 2);

      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#05070d";
      ctx.fillRect(left - 1, top - 1, w + 2, h + 2);
      ctx.fillStyle = "#101725";
      ctx.fillRect(left, top, w, h);
      ctx.fillStyle = fg;
      ctx.fillRect(left, top, w, 1);
      ctx.fillText(text, Math.floor(centerX), top + 1);
      ctx.restore();
    };

    const nearInteractionPoint = getNearbyInteractionPoint(agent.pos.x, agent.pos.y, 20);
    const indicatorPulse = Math.sin(timestamp / 180 + originalIndex * 0.83) * 0.5 + 0.5;
    const indicatorX = x + SPRITE_DISPLAY / 2;

    if (agent.action === "chatting") {
      const frame = Math.floor((timestamp + originalIndex * 160) / 260) % 3;
      const text = frame === 0 ? "." : frame === 1 ? ".." : "...";
      const py = baseY - 10 + Math.sin(timestamp / 170 + originalIndex) * 2;
      drawIndicatorTag(text, indicatorX, py, "#ecf2ff", 0.55 + indicatorPulse * 0.45);
    } else if (agent.action === "seeking_friend") {
      const frame = Math.floor((timestamp + originalIndex * 190) / 360) % 2;
      const text = frame === 0 ? "?" : "!?";
      const py = baseY - 11 + Math.sin(timestamp / 160 + originalIndex) * 2;
      drawIndicatorTag(text, indicatorX, py, "#9ff6ff", 0.5 + indicatorPulse * 0.45);
    } else if (agent.state === "working") {
      const cycle = (timestamp + originalIndex * 220) % 1200;
      const rise = cycle / 1200;
      const py = baseY - 10 - rise * 7;
      drawIndicatorTag("RUN", indicatorX, py, "#7ee6a8", (1 - rise) * 0.8 + 0.2);
    } else if (agent.state === "sick") {
      const py = baseY - 10 + Math.sin(timestamp / 95 + originalIndex) * 2;
      drawIndicatorTag("!!", indicatorX, py, "#f47067", 0.45 + indicatorPulse * 0.55);
    } else if (nearInteractionPoint) {
      const shouldSpark = Math.sin(timestamp / 240 + nearInteractionPoint.group + originalIndex * 0.2) > -0.25;
      if (shouldSpark) {
        const py = baseY - 10 + Math.sin(timestamp / 220 + nearInteractionPoint.group) * 2;
        drawIndicatorTag("*", indicatorX, py, "#9ff6ff", 0.35 + indicatorPulse * 0.4);
      }
    }

    // Name label: draw a pixel plate for legibility against noisy backgrounds.
    const labelX = x + SPRITE_DISPLAY / 2;
    const labelY = baseY + SPRITE_DISPLAY + 14;
    const nameText = agent.name.toUpperCase();
    const nameBorderColor = isSelected ? (TYPE_COLORS[agent.type] || "#7eb8f6") : "#2c3750";

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "8px 'Departure Mono', 'Noto Emoji', monospace";
    const nameWidth = Math.ceil(ctx.measureText(nameText).width) + 8;
    const nameHeight = 10;
    const nameLeft = Math.floor(labelX - nameWidth / 2);
    const nameTop = Math.floor(labelY - 8);

    ctx.fillStyle = nameBorderColor;
    ctx.fillRect(nameLeft - 1, nameTop - 1, nameWidth + 2, nameHeight + 2);
    ctx.fillStyle = "#0a0f18";
    ctx.fillRect(nameLeft, nameTop, nameWidth, nameHeight);
    ctx.fillStyle = isSelected ? "#f4f8ff" : "#d1d8ea";
    ctx.fillText(nameText, labelX, nameTop + 1);

    if (agent.lastRun) {
      const runText = timeAgo(agent.lastRun).toUpperCase();
      ctx.font = "7px 'Departure Mono', 'Noto Emoji', monospace";
      const runWidth = Math.ceil(ctx.measureText(runText).width) + 6;
      const runHeight = 8;
      const runLeft = Math.floor(labelX - runWidth / 2);
      const runTop = nameTop + nameHeight + 1;
      ctx.fillStyle = "#202a40";
      ctx.fillRect(runLeft - 1, runTop - 1, runWidth + 2, runHeight + 2);
      ctx.fillStyle = "#0f1626";
      ctx.fillRect(runLeft, runTop, runWidth, runHeight);
      ctx.fillStyle = "#9aa7c4";
      ctx.fillText(runText, labelX, runTop + 1);
    }
    ctx.restore();
  }
}

// ---- Bubble System ----

function updateBubble(timestamp) {
  const overlay = document.getElementById("bubble-overlay");
  if (!overlay) return;
  const visibleAgents = getVisibleAgents();
  if (visibleAgents.length === 0) {
    overlay.classList.remove("visible");
    overlay.style.opacity = "";
    return;
  }

  // Rotate through visible agents' bubbles.
  if (timestamp - lastBubbleRotate > BUBBLE_ROTATE_MS) {
    lastBubbleRotate = timestamp;
    bubbleIndex = (bubbleIndex + 1) % visibleAgents.length;
    bubbleVisibleUntil = timestamp + BUBBLE_VISIBLE_MS;
  }
  if (bubbleVisibleUntil === 0) {
    bubbleVisibleUntil = timestamp + BUBBLE_VISIBLE_MS;
  }

  const timeLeft = bubbleVisibleUntil - timestamp;
  if (timeLeft <= 0) {
    overlay.classList.remove("visible");
    overlay.style.opacity = "";
    return;
  }

  if (bubbleIndex >= visibleAgents.length) bubbleIndex = 0;
  const agent = visibleAgents[bubbleIndex];
  if (!agent) return;
  const bubble = typeof agent.bubble === "string" && agent.bubble.trim() ? agent.bubble.trim() : "...";
  if (activeBubbleAgentName !== agent.name || activeBubbleText !== bubble) {
    overlay.innerHTML =
      `<div class="bubble-agent">${agent.name}</div>` +
      `<div class="bubble-body">${escapeHtml(bubble)}</div>`;
    activeBubbleAgentName = agent.name;
    activeBubbleText = bubble;
    logAgentEvent(truncateText(bubble.replace(/\s+/g, " "), 96), {
      agentName: agent.name,
      kind: "chat",
      dedupeKey: `bubble:${agent.name}:${bubble.slice(0, 64)}`,
      cooldownMs: 9000,
    });
  }

  const elapsed = BUBBLE_VISIBLE_MS - timeLeft;
  const fadeIn = Math.min(1, elapsed / BUBBLE_FADE_MS);
  const fadeOut = Math.min(1, timeLeft / BUBBLE_FADE_MS);
  const bubbleAlpha = Math.max(0.08, Math.min(fadeIn, fadeOut));
  overlay.classList.add("visible");
  overlay.style.opacity = bubbleAlpha.toFixed(3);
  
  if (view === "grid" && agent.pos) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    
    const px = rect.left + agent.pos.x * scaleX;
    const lift = Math.sin(timestamp / 230 + bubbleIndex * 0.7) * 2;
    const py = rect.top + agent.pos.y * scaleY - (SPRITE_DISPLAY / 2 * scaleY) - 20 + lift;
    
    overlay.style.left = px + "px";
    overlay.style.top = py + "px";
    overlay.style.bottom = "auto";
    overlay.style.transform = "translate(-50%, -100%)";
  } else {
    overlay.style.left = "50%";
    overlay.style.bottom = "40px";
    overlay.style.top = "auto";
    overlay.style.transform = "translateX(-50%)";
  }
}

// ---- Chat System ----

function getHistory(agentName) {
  if (!chatHistory[agentName]) chatHistory[agentName] = [];
  return chatHistory[agentName];
}

/** Load persistent session history from Honcho via the server.
 *  Only fetches if local history is empty (e.g. page refresh). */
async function loadSessionHistory(agentName) {
  const history = getHistory(agentName);
  if (history.length > 0) return; // already have local history

  try {
    const res = await fetch(`/api/chat/${agentName}/history`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.messages || data.messages.length === 0) return;

    // Populate local history from Honcho session
    chatHistory[agentName] = data.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    console.log(`[session] Loaded ${data.messages.length} messages for ${agentName} from Honcho`);

    // Re-render if we're still viewing this agent
    if (profileAgent && profileAgent.name === agentName) {
      renderChatMessages(agentName);
    }
  } catch (err) {
    console.warn(`[session] Failed to load history for ${agentName}:`, err);
  }
}

/**
 * Rebuild traceHistory from chat messages that have toolCalls attached.
 * Called when opening a profile to restore trace state from in-session history.
 */
function rebuildTraceHistory(agentName) {
  const history = chatHistory[agentName] || [];
  if (!traceHistory[agentName]) traceHistory[agentName] = [];
  const existingIds = new Set(traceHistory[agentName].map((tc) => tc.id));
  for (const msg of history) {
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (!existingIds.has(tc.id)) {
          traceHistory[agentName].push(tc);
          existingIds.add(tc.id);
        }
      }
    }
  }
}

function renderTraceEntries(agentName) {
  const container = document.getElementById("trace-entries");
  if (!container) return;
  const statusEl = document.getElementById("trace-status");

  const allEntries = traceHistory[agentName] || [];
  if (!traceExpandedIds[agentName]) traceExpandedIds[agentName] = new Set();
  const expanded = traceExpandedIds[agentName];
  const filter = traceFilterIds[agentName] || null;

  // Apply filter if set
  const entries = filter ? allEntries.filter((tc) => filter.has(tc.id)) : allEntries;

  if (allEntries.length === 0) {
    container.innerHTML = '<div class="trace-empty">tool calls appear here</div>';
    if (statusEl) statusEl.textContent = "0 calls";
    renderDjTraceControls(agentName);
    return;
  }

  // Show all button when filtered
  const filterBar = filter
    ? `<div class="trace-filter-bar"><span>${entries.length} of ${allEntries.length} calls</span><button class="trace-show-all" type="button">ALL</button></div>`
    : "";

  container.innerHTML = filterBar + entries.map((tc) => {
    const isExpanded = expanded.has(tc.id);
    const statusClass = tc.result.success ? "success" : "error";
    const argsStr = Object.keys(tc.args).length > 0 ? JSON.stringify(tc.args, null, 2) : "{}";
    const resultStr = JSON.stringify(tc.result.data ?? tc.result.error, null, 2);
    const resultClass = tc.result.success ? "result" : "result error";

    return `<div class="trace-entry${isExpanded ? " expanded" : ""}" data-trace-id="${tc.id}">
      <div class="trace-entry-header">
        <div class="trace-indicator ${statusClass}"></div>
        <span class="trace-fn-name">${escapeHtml(tc.name)}</span>
        <span class="trace-timing">${tc.durationMs}ms</span>
      </div>
      <div class="trace-detail">
        <div class="trace-detail-section">
          <div class="trace-detail-label">args</div>
          <div class="trace-detail-body args">${escapeHtml(argsStr)}</div>
        </div>
        <div class="trace-detail-section">
          <div class="trace-detail-label">${tc.result.success ? "result" : "error"}</div>
          <div class="trace-detail-body ${resultClass}">${escapeHtml(resultStr)}</div>
        </div>
      </div>
    </div>`;
  }).join("");

  // Attach click listeners for expand/collapse
  container.querySelectorAll(".trace-entry").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-trace-id");
      if (expanded.has(id)) {
        expanded.delete(id);
        el.classList.remove("expanded");
      } else {
        expanded.add(id);
        el.classList.add("expanded");
      }
    });
  });

  // "ALL" button clears the filter
  const showAllBtn = container.querySelector(".trace-show-all");
  if (showAllBtn) {
    showAllBtn.addEventListener("click", () => {
      traceFilterIds[agentName] = null;
      renderTraceEntries(agentName);
      // Clear active-trace highlight on chat messages
      const chatContainer = document.getElementById("chat-messages");
      if (chatContainer) {
        chatContainer.querySelectorAll(".chat-msg.active-trace").forEach((el) => el.classList.remove("active-trace"));
      }
    });
  }

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;

  // Update trace status count
  if (statusEl) {
    const total = allEntries.length;
    const shown = entries.length;
    statusEl.textContent = filter
      ? `${shown}/${total} calls`
      : `${total} call${total !== 1 ? "s" : ""}`;
  }
  renderDjTraceControls(agentName);
}

function setTracePanelVisible(visible) {
  const panel = document.getElementById("profile-panel");
  const toggleBtn = document.getElementById("trace-toggle");
  if (!panel || !toggleBtn) return;

  tracePanelVisible = visible;
  panel.classList.toggle("trace-collapsed", !visible);
  toggleBtn.textContent = visible ? "HIDE TRACE" : "SHOW TRACE";
  toggleBtn.setAttribute("aria-pressed", visible ? "true" : "false");
}

function getDjAgent() {
  return agents.find((agent) => String(agent?.name || "").trim().toLowerCase() === DJ_AGENT_NAME) || null;
}

function isDjAvailable() {
  const dj = getDjAgent();
  if (!dj) return false;
  return isAgentVisibleName(DJ_AGENT_NAME);
}

function updateDjStatusUi() {
  const boomboxState = document.getElementById("dj-boombox-state");
  const traceFeedback = document.getElementById("dj-trace-feedback");
  const modeClasses = ["playing", "paused", "error"];
  const safeText = truncateText(String(djStatusText || "idle"), DJ_STATUS_TEXT_LIMIT);

  if (boomboxState) {
    boomboxState.textContent = safeText;
    boomboxState.classList.remove(...modeClasses);
    if (modeClasses.includes(djStatusMode)) {
      boomboxState.classList.add(djStatusMode);
    }
  }
  if (traceFeedback) {
    traceFeedback.textContent = safeText;
    traceFeedback.classList.remove(...modeClasses);
    if (modeClasses.includes(djStatusMode)) {
      traceFeedback.classList.add(djStatusMode);
    }
  }
}

function setDjStatus(text, mode = "idle") {
  djStatusText = String(text || "idle").replace(/\s+/g, " ").trim() || "idle";
  djStatusMode = mode;
  updateDjStatusUi();
}

function setDjControlBusy(isBusy) {
  const busy = Boolean(isBusy);
  const controlIds = [
    "dj-boombox-play",
    "dj-boombox-pause",
    "dj-trace-play",
    "dj-trace-pause",
    "dj-track-request",
    "dj-track-query",
    "dj-track-input",
  ];
  for (const id of controlIds) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = busy;
  }
}

function syncDjUiState() {
  const boombox = document.getElementById("dj-boombox");
  const available = isDjAvailable();
  if (boombox) {
    boombox.hidden = !(available && view === "grid");
  }
  if (!available) {
    setDjStatus("dj offline", "error");
  } else if (!djStatusText || djStatusText === "dj offline") {
    setDjStatus("idle");
  } else {
    updateDjStatusUi();
  }
  setDjControlBusy(djControlInFlight || !available);
}

function renderDjTraceControls(agentName) {
  const controls = document.getElementById("dj-trace-controls");
  if (!controls) return;
  const isDjProfile =
    view === "profile" &&
    profileAgent &&
    profileAgent.name === DJ_AGENT_NAME &&
    agentName === DJ_AGENT_NAME;
  controls.hidden = !isDjProfile;
  if (!isDjProfile) return;
  syncDjUiState();
}

function buildDjCommand(action, rawQuery = "") {
  const query = String(rawQuery || "").replace(/\s+/g, " ").trim();
  if (action === "play") {
    return {
      userText: "[dj control] play",
      prompt:
        "Switch to PLAY mode now. Confirm what's playing in one short line. If no track is active, choose one and start it.",
      successMode: "playing",
    };
  }
  if (action === "pause") {
    return {
      userText: "[dj control] pause",
      prompt: "Pause playback now. Confirm paused state in one short line.",
      successMode: "paused",
    };
  }
  if (action === "request" && query) {
    return {
      userText: `[dj request] ${query}`,
      prompt:
        `Listener request: "${query}". Pick a fitting track and respond in one short line as "track - artist" plus a brief reason.`,
      successMode: "playing",
      query,
    };
  }
  if (action === "query" && query) {
    return {
      userText: `[dj query] ${query}`,
      prompt:
        `Find a NEW track recommendation for this vibe: "${query}". Respond in one short line as "track - artist" plus a brief reason.`,
      successMode: "idle",
      query,
    };
  }
  return null;
}

function appendDjControlTrace(action, query, ok, durationMs, payload) {
  if (!traceHistory[DJ_AGENT_NAME]) traceHistory[DJ_AGENT_NAME] = [];
  const actionName = action === "play"
    ? "dj_playback_play"
    : action === "pause"
      ? "dj_playback_pause"
      : action === "request"
        ? "dj_track_request"
        : "dj_track_query";
  const traceId = `djctl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  traceHistory[DJ_AGENT_NAME].push({
    id: traceId,
    name: actionName,
    args: {
      action,
      ...(query ? { query } : {}),
    },
    result: ok
      ? { success: true, data: payload }
      : { success: false, data: null, error: payload?.error || "request failed" },
    durationMs,
  });
  if (traceHistory[DJ_AGENT_NAME].length > 260) {
    traceHistory[DJ_AGENT_NAME] = traceHistory[DJ_AGENT_NAME].slice(-260);
  }
}

async function runDjCommand(action, rawQuery = "") {
  if (djControlInFlight) return;
  syncDjUiState();
  if (!isDjAvailable()) {
    setDjStatus("dj offline", "error");
    return;
  }

  const command = buildDjCommand(action, rawQuery);
  if (!command) {
    setDjStatus("enter a track request first", "error");
    const input = document.getElementById("dj-track-input");
    if (input) input.focus();
    return;
  }

  const history = getHistory(DJ_AGENT_NAME);
  history.push({ role: "user", content: command.userText });
  if (profileAgent && profileAgent.name === DJ_AGENT_NAME) {
    renderChatMessages(DJ_AGENT_NAME);
  }

  const started = performance.now();
  djControlInFlight = true;
  setDjStatus("dj thinking...", "idle");
  syncDjUiState();

  try {
    const res = await fetch(`/api/chat/${DJ_AGENT_NAME}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: command.prompt,
        history: history
          .filter((m) => m.role !== "system")
          .filter((m) => !String(m.content || "").startsWith("[error:"))
          .slice(0, -1)
          .slice(-DJ_CONTROL_HISTORY_LIMIT),
      }),
    });
    const data = await res.json();
    const durationMs = Math.round(performance.now() - started);

    if (data.error) {
      const errorText = String(data.error);
      history.push({ role: "assistant", content: `[error: ${errorText}]` });
      appendDjControlTrace(action, command.query, false, durationMs, { error: errorText });
      setDjStatus(`error: ${truncateText(errorText, 72)}`, "error");
      logAgentEvent(`dj control failed: ${truncateText(errorText, 72)}`, {
        agentName: DJ_AGENT_NAME,
        kind: "state",
        dedupeKey: `dj-control-error:${action}:${errorText.slice(0, 40)}`,
        cooldownMs: 1200,
      });
    } else {
      const responseText = String(data.response || "").trim() || "ok";
      const msgEntry = { role: "assistant", content: responseText };
      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
        msgEntry.toolCalls = data.toolCalls;
      }
      history.push(msgEntry);
      appendDjControlTrace(action, command.query, true, durationMs, { response: responseText });

      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
        if (!traceHistory[DJ_AGENT_NAME]) traceHistory[DJ_AGENT_NAME] = [];
        const existingIds = new Set(traceHistory[DJ_AGENT_NAME].map((tc) => tc.id));
        for (const tc of data.toolCalls) {
          if (!tc || existingIds.has(tc.id)) continue;
          traceHistory[DJ_AGENT_NAME].push(tc);
          existingIds.add(tc.id);
          logAgentEvent(`${DJ_AGENT_NAME} ran ${tc.name} (${tc.durationMs}ms)`, {
            agentName: DJ_AGENT_NAME,
            kind: "run",
            dedupeKey: `dj-tool:${tc.id || tc.name}:${tc.durationMs}`,
            cooldownMs: 0,
            meta: {
              traceId: tc.id || null,
              traceName: tc.name || null,
              durationMs: typeof tc.durationMs === "number" ? tc.durationMs : null,
              argsPreview: toPreviewText(tc.args, 180),
              resultPreview: toPreviewText(tc.result, 180),
            },
          });
        }
      }

      setDjStatus(responseText, command.successMode);
      logAgentEvent(truncateText(responseText.replace(/\s+/g, " "), 84), {
        agentName: DJ_AGENT_NAME,
        kind: "chat",
        dedupeKey: `dj-control-reply:${action}:${responseText.slice(0, 48)}`,
        cooldownMs: 700,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Math.round(performance.now() - started);
    history.push({ role: "assistant", content: `[could not reach ${DJ_AGENT_NAME}]` });
    appendDjControlTrace(action, command.query, false, durationMs, { error: msg });
    setDjStatus("could not reach dj", "error");
    logAgentEvent("dj control failed: unreachable", {
      agentName: DJ_AGENT_NAME,
      kind: "state",
      dedupeKey: `dj-control-unreachable:${action}`,
      cooldownMs: 2200,
    });
  } finally {
    djControlInFlight = false;
    syncDjUiState();
    saveTraceHistory();
    if (profileAgent && profileAgent.name === DJ_AGENT_NAME) {
      renderChatMessages(DJ_AGENT_NAME);
      renderTraceEntries(DJ_AGENT_NAME);
      const input = document.getElementById("dj-track-input");
      if (input && (action === "request" || action === "query")) {
        input.value = "";
        input.focus();
      }
    }
  }
}

function normalizeChatText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function sanitizeMarkdownUrl(rawUrl) {
  const source = String(rawUrl ?? "").trim();
  if (!source) return null;
  if (source.startsWith("/")) return source;
  try {
    const parsed = new URL(source, window.location.origin);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

function renderMarkdownInline(rawText) {
  let text = String(rawText ?? "");
  const slots = [];
  const stash = (html) => {
    const token = `\u0001${slots.length}\u0001`;
    slots.push(html);
    return token;
  };

  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    return stash(`<code class="chat-md-inline-code">${escapeHtml(code)}</code>`);
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const safeHref = sanitizeMarkdownUrl(href);
    const safeLabel = escapeHtml(label);
    if (!safeHref) {
      return `${safeLabel} (${escapeHtml(href)})`;
    }
    return stash(
      `<a class="chat-md-link" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`
    );
  });

  text = escapeHtml(text);
  text = text
    .replace(/\*\*([^*][\s\S]*?)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n][^~\n]*?)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])\*([^*\n][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");

  return text.replace(/\u0001(\d+)\u0001/g, (_match, idx) => slots[Number(idx)] || "");
}

function renderMarkdownBlocks(rawBlock) {
  const lines = normalizeChatText(rawBlock).split("\n");
  const html = [];
  let i = 0;

  const isRuleLine = (line) => /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim());
  const isHeadingLine = (line) => /^(#{1,3})\s+/.test(line);
  const isQuoteLine = (line) => /^>\s?/.test(line);
  const isBulletLine = (line) => /^[-*]\s+/.test(line);
  const isNumberLine = (line) => /^\d+\.\s+/.test(line);

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      html.push(`<div class="chat-md-h${level}">${renderMarkdownInline(heading[2].trim())}</div>`);
      i += 1;
      continue;
    }

    if (isRuleLine(line)) {
      html.push('<hr class="chat-md-rule" />');
      i += 1;
      continue;
    }

    if (isQuoteLine(line)) {
      const quoteLines = [];
      while (i < lines.length && isQuoteLine(lines[i] ?? "")) {
        quoteLines.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      const quoteText = quoteLines.map((part) => renderMarkdownInline(part)).join("<br />");
      html.push(`<blockquote>${quoteText}</blockquote>`);
      continue;
    }

    if (isBulletLine(line)) {
      const items = [];
      while (i < lines.length && isBulletLine(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
        i += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (isNumberLine(line)) {
      const items = [];
      while (i < lines.length && isNumberLine(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</ol>`);
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !isHeadingLine(lines[i] ?? "") &&
      !isRuleLine(lines[i] ?? "") &&
      !isQuoteLine(lines[i] ?? "") &&
      !isBulletLine(lines[i] ?? "") &&
      !isNumberLine(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    const text = paragraph.map((part) => renderMarkdownInline(part.trimEnd())).join("<br />");
    html.push(`<p>${text}</p>`);
  }

  return html.join("");
}

function renderChatMarkdown(rawText) {
  const text = normalizeChatText(rawText);
  if (!text.trim()) return "";

  const chunks = [];
  const fence = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let cursor = 0;
  let match = fence.exec(text);

  while (match) {
    const before = text.slice(cursor, match.index);
    if (before.trim()) {
      chunks.push(renderMarkdownBlocks(before));
    } else if (before) {
      chunks.push("");
    }

    const lang = (match[1] || "").trim();
    const body = (match[2] || "").replace(/\n$/, "");
    const safeLang = escapeHtml(lang);
    chunks.push(
      `<pre class="chat-md-pre"${safeLang ? ` data-lang="${safeLang}"` : ""}><code>${escapeHtml(body)}</code></pre>`
    );
    cursor = match.index + match[0].length;
    match = fence.exec(text);
  }

  const rest = text.slice(cursor);
  if (rest.trim()) {
    chunks.push(renderMarkdownBlocks(rest));
  } else if (rest) {
    chunks.push("");
  }

  if (chunks.length === 0) {
    return `<p>${renderMarkdownInline(text)}</p>`;
  }
  return chunks.join("");
}

function streamChunkSize(textLength) {
  if (textLength > 1800) return 34;
  if (textLength > 1200) return 24;
  if (textLength > 800) return 16;
  if (textLength > 480) return 10;
  if (textLength > 220) return 7;
  return 4;
}

function streamChunkDelayMs(textLength) {
  if (textLength > 1800) return 8;
  if (textLength > 1200) return 10;
  if (textLength > 800) return 12;
  if (textLength > 400) return 14;
  return 18;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamAssistantReply(container, agentType, fullText) {
  if (!container) return;
  const text = normalizeChatText(fullText);
  if (!text) return;

  const streamEl = document.createElement("div");
  streamEl.className = "chat-msg agent streaming";
  streamEl.setAttribute("data-type", agentType || "");
  const markdownEl = document.createElement("div");
  markdownEl.className = "chat-markdown";
  streamEl.appendChild(markdownEl);
  container.appendChild(streamEl);
  container.scrollTop = container.scrollHeight;

  const size = streamChunkSize(text.length);
  const delay = streamChunkDelayMs(text.length);
  let cursor = 0;

  while (cursor < text.length) {
    if (!streamEl.isConnected) return;
    cursor = Math.min(text.length, cursor + size);
    markdownEl.innerHTML = renderChatMarkdown(text.slice(0, cursor));
    container.scrollTop = container.scrollHeight;
    if (cursor < text.length) {
      await sleepMs(delay);
    }
  }

  if (!streamEl.isConnected) return;
  markdownEl.innerHTML = renderChatMarkdown(text);
  streamEl.classList.remove("streaming");
  container.scrollTop = container.scrollHeight;
}

function renderChatMessages(agentName) {
  const container = document.getElementById("chat-messages");
  const history = getHistory(agentName);

  if (history.length === 0) {
    container.innerHTML =
      '<div style="color: var(--fg-muted); font-size: 11px; font-family: var(--font-mono); padding: 8px 0; text-align: center;">say something</div>';
    return;
  }

  container.innerHTML = history
    .map((msg, idx) => {
      const content = `<div class="chat-markdown">${renderChatMarkdown(msg.content)}</div>`;
      if (msg.role === "user") {
        // Check for attached photo
        if (msg.photo) {
          const imgTag = msg.photo.objectUrl
            ? `<img class="chat-photo-thumb" src="${msg.photo.objectUrl}" alt="${escapeHtml(msg.photo.filename)}" />`
            : "";
          const label = `<div style="font-family: var(--font-mono); font-size: 9px; color: var(--type-production); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.06em;">img: ${escapeHtml(msg.photo.filename)}</div>`;
          return `<div class="chat-msg user">${imgTag}${label}${content}</div>`;
        }
        return `<div class="chat-msg user">${content}</div>`;
      }
      const tcCount = msg.toolCalls ? msg.toolCalls.length : 0;
      const tcBadge = tcCount > 0
        ? `<span class="chat-msg-tc-badge" data-msg-idx="${idx}">${tcCount} call${tcCount !== 1 ? "s" : ""}</span>`
        : "";
      const clickable = tcCount > 0 ? ` has-traces` : "";
      return `<div class="chat-msg agent${clickable}" data-type="${profileAgent?.type || ""}" data-msg-idx="${idx}">${content}${tcBadge}</div>`;
    })
    .join("");

  // Click handler: clicking an agent message with tool calls shows them in trace panel
  container.querySelectorAll(".chat-msg.has-traces").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.getAttribute("data-msg-idx"), 10);
      const msg = history[idx];
      if (!msg || !msg.toolCalls) return;

      // Populate trace panel with this message's tool calls
      if (!traceHistory[agentName]) traceHistory[agentName] = [];

      // Check if these calls are already in traceHistory (avoid duplicates)
      const existingIds = new Set(traceHistory[agentName].map((tc) => tc.id));
      for (const tc of msg.toolCalls) {
        if (!existingIds.has(tc.id)) {
          traceHistory[agentName].push(tc);
        }
      }

      // Highlight this message's calls by setting a filter
      traceFilterIds[agentName] = new Set(msg.toolCalls.map((tc) => tc.id));
      renderTraceEntries(agentName);

      // Make trace panel visible
      setTracePanelVisible(true);

      // Visual feedback: highlight the clicked message
      container.querySelectorAll(".chat-msg.active-trace").forEach((el) => el.classList.remove("active-trace"));
      el.classList.add("active-trace");
    });
  });

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ---- Photo Upload ----

async function uploadPhoto(file) {
  const formData = new FormData();
  formData.append("photo", file);

  const res = await fetch("/api/upload/photo", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status}`);
  }

  return res.json();
}

function showUploadPreview(file, uploadData) {
  const preview = document.getElementById("photo-upload-preview");
  const thumb = document.getElementById("photo-upload-thumb");
  const name = document.getElementById("photo-upload-name");
  const btn = document.getElementById("photo-upload-btn");

  const objectUrl = URL.createObjectURL(file);
  thumb.src = objectUrl;
  name.textContent = `${file.name} (${(file.size / 1024).toFixed(0)}KB)`;
  preview.style.display = "flex";
  btn.classList.add("has-file");

  pendingUpload = { ...uploadData, objectUrl };
}

function clearPendingUpload(revokeUrl = false) {
  const preview = document.getElementById("photo-upload-preview");
  const thumb = document.getElementById("photo-upload-thumb");
  const btn = document.getElementById("photo-upload-btn");

  if (revokeUrl && pendingUpload && pendingUpload.objectUrl) {
    URL.revokeObjectURL(pendingUpload.objectUrl);
  }
  pendingUpload = null;
  preview.style.display = "none";
  thumb.src = "";
  btn.classList.remove("has-file");
}

// ---- Chat ----

async function sendChat(agentName, message) {
  if (chatSending) return;
  if (!message.trim() && !pendingUpload) return;
  // Default message when uploading with no text
  if (!message.trim() && pendingUpload) message = "analyze this";
  const contextRef = activeChatEventContext && activeChatEventContext.agentName === agentName
    ? activeChatEventContext
    : null;
  const messageForServer = contextRef
    ? `${buildChatEventReferenceBlock(contextRef)}\n\nUser follow-up: ${message}`
    : message;
  if (contextRef) {
    clearActiveChatEventContext();
  }

  const history = getHistory(agentName);
  // Store message with photo metadata if there's a pending upload
  const entry = { role: "user", content: message };
  if (pendingUpload) {
    entry.photo = {
      filename: pendingUpload.filename,
      objectUrl: pendingUpload.objectUrl,
      uploadId: pendingUpload.id,
    };
  }
  history.push(entry);
  renderChatMessages(agentName);

  // Show thinking indicator
  const container = document.getElementById("chat-messages");
  const thinkingEl = document.createElement("div");
  thinkingEl.className = "chat-msg thinking";
  thinkingEl.textContent = `${agentName} is thinking...`;
  container.appendChild(thinkingEl);
  container.scrollTop = container.scrollHeight;

  chatSending = true;
  const sendBtn = document.getElementById("chat-send");
  const input = document.getElementById("chat-input");
  sendBtn.disabled = true;
  input.value = "";

  // Capture and clear pending upload
  const uploadId = pendingUpload ? pendingUpload.id : undefined;
  if (pendingUpload) {
    clearPendingUpload();
  }

  try {
    const res = await fetch(`/api/chat/${agentName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: messageForServer,
        uploadId,
        history: history
          .filter((m) => m.role !== "system")
          .filter((m) => !m.content.startsWith("[error:")) // don't send error msgs as history
          .slice(0, -1) // exclude current msg (server adds it via `message` field)
          .slice(-10),
      }),
    });

    const data = await res.json();

    if (data.error) {
      thinkingEl.remove();
      history.push({ role: "assistant", content: `[error: ${data.error}]` });
      logAgentEvent(`report failed: ${truncateText(String(data.error).replace(/\s+/g, " "), 60)}`, {
        agentName,
        kind: "state",
        dedupeKey: `chat-error:${agentName}:${String(data.error).slice(0, 48)}`,
        cooldownMs: 1400,
      });
    } else {
      thinkingEl.remove();
      const responseText = String(data.response || "");
      const streamTarget = profileAgent && profileAgent.name === agentName
        ? document.getElementById("chat-messages")
        : null;
      if (streamTarget && responseText.trim()) {
        await streamAssistantReply(streamTarget, profileAgent?.type || "", responseText);
      }

      const msgEntry = { role: "assistant", content: responseText };
      // Attach tool calls to the message so they persist and can be inspected
      if (data.toolCalls && data.toolCalls.length > 0) {
        msgEntry.toolCalls = data.toolCalls;
      }
      history.push(msgEntry);
      logAgentEvent(truncateText(responseText.replace(/\s+/g, " "), 84), {
        agentName,
        kind: "chat",
        dedupeKey: `reply:${agentName}:${responseText.slice(0, 56)}`,
        cooldownMs: 900,
      });

      // Auto-open URL if the agent produced one (e.g. photoblog publish)
      if (data.openUrl) {
        openWebview(data.openUrl);
      }

      // Process tool calls into trace panel
      if (data.toolCalls && data.toolCalls.length > 0) {
        if (!traceHistory[agentName]) traceHistory[agentName] = [];
        for (const tc of data.toolCalls) {
          traceHistory[agentName].push(tc);
          logAgentEvent(`${agentName} ran ${tc.name} (${tc.durationMs}ms)`, {
            agentName,
            kind: "run",
            dedupeKey: `tool:${agentName}:${tc.id || tc.name}:${tc.durationMs}`,
            cooldownMs: 0,
            meta: {
              traceId: tc.id || null,
              traceName: tc.name || null,
              durationMs: typeof tc.durationMs === "number" ? tc.durationMs : null,
              argsPreview: toPreviewText(tc.args, 220),
              resultPreview: toPreviewText(tc.result, 220),
            },
          });
        }
        renderTraceEntries(agentName);
        saveTraceHistory();
      }
    }
  } catch (err) {
    thinkingEl.remove();
    history.push({ role: "assistant", content: `[could not reach ${agentName}]` });
    logAgentEvent("report failed: unreachable", {
      agentName,
      kind: "state",
      dedupeKey: `unreachable:${agentName}`,
      cooldownMs: 2600,
    });
  }

  chatSending = false;
  sendBtn.disabled = false;
  if (profileAgent && profileAgent.name === agentName) {
    renderChatMessages(agentName);
    input.focus();
  }
}

// ---- Voice Playback ----

async function speakAgent(agentName, text) {
  if (voicePlaying) {
    // Stop current playback
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    voicePlaying = false;
    return;
  }

  voicePlaying = true;

  // Update speak button
  const speakHint = document.querySelector("#profile-controls .control-hint:nth-child(2)");
  if (speakHint) speakHint.innerHTML = '<kbd>S</kbd> speaking...';

  try {
    const body = text ? { text } : {};
    const res = await fetch(`/api/voice/${agentName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      console.warn("[voice]", err.error);
      voicePlaying = false;
      if (speakHint) speakHint.innerHTML = '<kbd>S</kbd> speak';
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);

    currentAudio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      voicePlaying = false;
      currentAudio = null;
      if (speakHint) speakHint.innerHTML = '<kbd>S</kbd> speak';
    });

    currentAudio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      voicePlaying = false;
      currentAudio = null;
      if (speakHint) speakHint.innerHTML = '<kbd>S</kbd> speak';
    });

    await currentAudio.play();
  } catch (err) {
    console.warn("[voice] playback failed:", err);
    voicePlaying = false;
    if (speakHint) speakHint.innerHTML = '<kbd>S</kbd> speak';
  }
}

// ---- Campfire View ----

function refreshCampfireAgentButtons() {
  const grid = document.getElementById("campfire-agent-grid");
  if (!grid) return [];

  const visibleAgents = getVisibleAgents();
  pruneCampfireSelectionToVisible();
  grid.innerHTML = "";

  if (!visibleAgents.length) {
    grid.innerHTML = '<div class="campfire-select-empty">no visible agents (enable from settings)</div>';
    return visibleAgents;
  }

  for (const agent of visibleAgents) {
    const btn = document.createElement("button");
    btn.className = "campfire-agent-btn";
    btn.setAttribute("data-type", agent.type);
    btn.setAttribute("data-name", agent.name);
    btn.textContent = agent.name;
    if (campfireSelected.has(agent.name)) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      if (campfireSelected.has(agent.name)) {
        campfireSelected.delete(agent.name);
        btn.classList.remove("selected");
      } else {
        campfireSelected.add(agent.name);
        btn.classList.add("selected");
      }
      updateCampfireSession();
    });
    grid.appendChild(btn);
  }

  // Default to all visible agents when opening with an empty selection.
  if (campfireSelected.size === 0) {
    visibleAgents.forEach((agent) => campfireSelected.add(agent.name));
    grid.querySelectorAll(".campfire-agent-btn").forEach((button) => button.classList.add("selected"));
  }

  return visibleAgents;
}

function resetCampfireLiveTracking() {
  campfireUpdateSinceTs = 0;
  campfireSeenRecordIds = new Set();
  campfireTraceEntries = [];
  campfireSeenTraceIds = new Set();
}

function appendCampfireTracesFromRecord(record, fallbackTsMs = Date.now()) {
  if (!record || typeof record !== "object") return false;
  const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  if (toolCalls.length === 0) return false;

  const traceAgent = typeof record.agent === "string" && record.agent.trim()
    ? record.agent.trim()
    : "system";
  const traceTs = Number.isFinite(fallbackTsMs) ? fallbackTsMs : Date.now();
  let changed = false;

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const name = typeof tc.name === "string" && tc.name.trim() ? tc.name.trim() : "tool";
    const durationMs = Number.isFinite(tc.durationMs) ? Math.max(0, Math.round(tc.durationMs)) : 0;
    const ok = tc?.result?.success !== false;

    const traceIdSource = typeof tc.id === "string" && tc.id.trim()
      ? tc.id.trim()
      : `${traceAgent}:${name}:${durationMs}:${String(tc?.result?.error || "").slice(0, 48)}`;
    const traceId = `${String(record.id || traceTs)}:${traceIdSource}`;
    if (campfireSeenTraceIds.has(traceId)) continue;
    campfireSeenTraceIds.add(traceId);

    const argsPreview = toPreviewText(tc.args, 130);
    const resultRaw = ok ? (tc?.result?.data ?? tc?.result) : (tc?.result?.error ?? tc?.result);
    const resultPreview = toPreviewText(resultRaw, 150);

    campfireTraceEntries.push({
      id: traceId,
      agent: traceAgent,
      name,
      ok,
      durationMs,
      argsPreview,
      resultPreview,
      tsMs: traceTs,
    });
    changed = true;
  }

  if (campfireTraceEntries.length > CAMPFIRE_TRACE_RENDER_LIMIT) {
    campfireTraceEntries = campfireTraceEntries.slice(-CAMPFIRE_TRACE_RENDER_LIMIT);
  }
  return changed;
}

function appendCampfireRecord(record) {
  if (!record || typeof record !== "object") return false;
  const agent = typeof record.agent === "string" && record.agent.trim()
    ? record.agent.trim()
    : "system";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) return false;

  const id = typeof record.id === "string" && record.id.trim()
    ? record.id.trim()
    : `${String(record.ts || "")}:${agent}:${message.slice(0, 80)}`;
  if (campfireSeenRecordIds.has(id)) return false;
  campfireSeenRecordIds.add(id);

  const tsIso = typeof record.ts === "string" ? record.ts : "";
  const parsedTs = Date.parse(tsIso);
  if (Number.isFinite(parsedTs) && parsedTs > campfireUpdateSinceTs) {
    campfireUpdateSinceTs = parsedTs;
  }
  appendCampfireTracesFromRecord(record, Number.isFinite(parsedTs) ? parsedTs : Date.now());

  const recentDup = campfireMessages
    .slice(Math.max(0, campfireMessages.length - 6))
    .some((entry) => entry.agent === agent && entry.message === message);
  if (recentDup) return false;

  campfireMessages.push({
    agent,
    message,
    type: agent === "system" ? "error" : "agent",
  });
  return true;
}

async function pollCampfireUpdates(force = false) {
  if (view !== "campfire" || !campfireSessionId) return;
  if (campfireUpdatesInFlight && !force) return;

  campfireUpdatesInFlight = true;
  try {
    const params = new URLSearchParams();
    params.set("session", campfireSessionId);
    params.set("limit", String(CAMPFIRE_UPDATES_LIMIT));
    if (campfireUpdateSinceTs > 0) {
      params.set("since", new Date(Math.max(0, campfireUpdateSinceTs - 800)).toISOString());
    }

    const res = await fetch(`/api/group/updates?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.messages)) return;

    let appended = false;
    const traceCountBefore = campfireTraceEntries.length;
    for (const record of data.messages) {
      if (appendCampfireRecord(record)) appended = true;
    }
    const traceChanged = campfireTraceEntries.length !== traceCountBefore;
    if (appended || traceChanged) {
      renderCampfireMessages();
      renderCampfireTraceEntries();
    }
  } catch {
    // best effort only
  } finally {
    campfireUpdatesInFlight = false;
  }
}

function startCampfireUpdatesPolling() {
  if (campfireUpdatesTimer !== null) return;
  campfireUpdatesTimer = window.setInterval(() => {
    void pollCampfireUpdates();
  }, CAMPFIRE_UPDATES_POLL_MS);
  void pollCampfireUpdates(true);
}

function stopCampfireUpdatesPolling() {
  if (campfireUpdatesTimer !== null) {
    clearInterval(campfireUpdatesTimer);
    campfireUpdatesTimer = null;
  }
}

function showCampfire() {
  if (isProfilePanelMenuOpen() || view === "profile") hideProfile();
  closeAgentMenu();
  closeAgentProfileWindow();
  if (!campfireSessionId) {
    resetCampfireLiveTracking();
  }
  view = "campfire";
  const panel = document.getElementById("campfire-panel");
  panel.classList.add("visible");
  const visibleAgents = refreshCampfireAgentButtons();

  updateCampfireSession();
  renderCampfireMessages();
  renderCampfireTraceEntries();
  startCampfireUpdatesPolling();

  if (visibleAgents.length > 0) {
    setTimeout(() => {
      document.getElementById("campfire-input").focus();
    }, 100);
  }
}

function hideCampfire() {
  view = "grid";
  document.getElementById("campfire-panel").classList.remove("visible");
  document.getElementById("campfire-input").blur();
  stopCampfireUpdatesPolling();
}

function updateCampfireSession() {
  const sessionEl = document.getElementById("campfire-session");
  if (!sessionEl) return;
  pruneCampfireSelectionToVisible();
  const visibleCount = getVisibleAgents().length;
  const names = [...campfireSelected].sort();
  if (visibleCount > 0 && names.length === visibleCount) {
    sessionEl.textContent = `dex:${getCampfireSessionToken()}`;
  } else if (names.length === 0) {
    sessionEl.textContent = "select agents";
  } else {
    sessionEl.textContent = "dex:" + names.join("+");
  }
}

function renderCampfireMessages() {
  const container = document.getElementById("campfire-messages");
  if (!container) return;
  const visibleCount = getVisibleAgents().length;
  if (visibleCount === 0) {
    container.innerHTML =
      '<div style="color: var(--fg-muted); font-size: 11px; font-family: var(--font-mono); padding: 16px 0; text-align: center;">enable at least one agent in settings</div>';
    return;
  }
  if (campfireMessages.length === 0) {
    container.innerHTML =
      '<div style="color: var(--fg-muted); font-size: 11px; font-family: var(--font-mono); padding: 16px 0; text-align: center;">select agents and start a conversation</div>';
    return;
  }

  container.innerHTML = campfireMessages
    .map((msg) => {
      const agentData = agents.find((a) => a.name === msg.agent);
      const agentType = agentData ? agentData.type : "";
      const isEri = msg.agent === "eri";
      const isThinking = msg.type === "thinking";

      const labelCls = isEri ? "eri" : "";
      const msgCls = isEri ? "eri-msg" : isThinking ? "thinking-msg" : "";

      return `<div class="campfire-msg ${msgCls}">
        <span class="agent-label ${labelCls}" data-type="${agentType}">${msg.agent}</span>
        <div class="msg-body"><div class="chat-markdown">${renderChatMarkdown(msg.message)}</div></div>
      </div>`;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

function renderCampfireTraceEntries() {
  const container = document.getElementById("campfire-trace-entries");
  const statusEl = document.getElementById("campfire-trace-status");
  if (!container) return;

  if (campfireTraceEntries.length === 0) {
    container.innerHTML = '<div class="campfire-trace-empty">group traces appear here</div>';
    if (statusEl) statusEl.textContent = "0 calls";
    return;
  }

  const entries = campfireTraceEntries.slice(-CAMPFIRE_TRACE_RENDER_LIMIT);
  container.innerHTML = entries
    .map((entry) => {
      const detailLine = entry.ok
        ? `args: ${entry.argsPreview}\nresult: ${entry.resultPreview}`
        : `args: ${entry.argsPreview}\nerror: ${entry.resultPreview}`;
      const statusCls = entry.ok ? "success" : "error";
      return `<div class="campfire-trace-entry ${statusCls}">
        <div class="campfire-trace-entry-head">
          <span class="campfire-trace-agent">${escapeHtml(entry.agent)}</span>
          <span class="campfire-trace-fn">${escapeHtml(entry.name)}</span>
          <span class="campfire-trace-time">${escapeHtml(String(entry.durationMs))}ms</span>
        </div>
        <div class="campfire-trace-detail">${escapeHtml(detailLine)}</div>
      </div>`;
    })
    .join("");
  container.scrollTop = container.scrollHeight;

  if (statusEl) {
    const total = campfireTraceEntries.length;
    statusEl.textContent = `${total} call${total !== 1 ? "s" : ""}`;
  }
}

async function sendCampfire(message) {
  pruneCampfireSelectionToVisible();
  const selected = [...campfireSelected];
  if (selected.length < 2 || campfireSending) return;

  campfireSending = true;
  const sendBtn = document.getElementById("campfire-send");
  const input = document.getElementById("campfire-input");
  sendBtn.disabled = true;
  input.value = "";

  // Show eri's message
  if (message && message.trim()) {
    campfireMessages.push({ agent: "eri", message: message.trim(), type: "user" });
    renderCampfireMessages();
  }

  // Show thinking indicator
  campfireMessages.push({ agent: "...", message: "waiting for next reply...", type: "thinking" });
  renderCampfireMessages();

  try {
    // Only send the last ~10 messages to keep context window manageable
    const history = campfireMessages
      .filter(m => m.type !== 'thinking' && m.type !== 'error')
      .slice(-10)
      .map(m => ({ agent: m.agent, message: m.message }));

    const res = await fetch("/api/group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agents: selected,
        message: message && message.trim() ? message.trim() : undefined,
        history,
        rounds: 1,
        maxImmediateReplies: 1,
        sessionId: campfireSessionId || undefined,
        autonomy: true,
      }),
    });

    const data = await res.json();

    // Track the session ID so adding/removing peers continues the same session
    if (data.session) {
      const incomingSession = String(data.session);
      if (campfireSessionId !== incomingSession) {
        resetCampfireLiveTracking();
      }
      campfireSessionId = incomingSession;
    }
    
    // Remove thinking indicator
    campfireMessages = campfireMessages.filter((m) => m.type !== "thinking");

    // Show response
    if (data.error) {
      campfireMessages.push({ agent: "system", message: `error: ${data.error}`, type: "error" });
      logAgentEvent(`report failed: ${truncateText(String(data.error).replace(/\s+/g, " "), 60)}`, {
        kind: "state",
        dedupeKey: `campfire-error:${String(data.error).slice(0, 48)}`,
        cooldownMs: 1400,
      });
    } else if (Array.isArray(data.records) && data.records.length > 0) {
      for (const record of data.records) {
        appendCampfireRecord(record);
      }
    } else if (Array.isArray(data.messages)) {
      for (const line of data.messages) {
        const agent = typeof line?.agent === "string" ? line.agent : "system";
        const text = typeof line?.message === "string" ? line.message : "";
        if (!text.trim()) continue;
        campfireMessages.push({ agent, message: text, type: agent === "system" ? "error" : "agent" });
        logAgentEvent(truncateText(text.replace(/\s+/g, " "), 84), {
          agentName: agent === "system" ? null : agent,
          kind: agent === "system" ? "state" : "chat",
          dedupeKey: `campfire-line:${agent}:${text.slice(0, 52)}`,
          cooldownMs: 700,
        });
        if (Array.isArray(line.toolCalls)) {
          appendCampfireTracesFromRecord({ agent, toolCalls: line.toolCalls }, Date.now());
        }
      }
    }
  } catch (err) {
    campfireMessages = campfireMessages.filter((m) => m.type !== "thinking");
    campfireMessages.push({ agent: "system", message: "could not reach agents", type: "error" });
    logAgentEvent("report failed: session unreachable", {
      kind: "state",
      dedupeKey: "campfire-unreachable",
      cooldownMs: 2600,
    });
  }

  campfireSending = false;
  sendBtn.disabled = false;
  renderCampfireMessages();
  renderCampfireTraceEntries();
  if (campfireSessionId) {
    startCampfireUpdatesPolling();
    void pollCampfireUpdates(true);
  }
  input.focus();
}

// ---- Profile View ----

function showProfile(agent, options = {}) {
  const setProfileStatusInfo = (value) => {
    const statusEl = document.getElementById("profile-status-info");
    if (!statusEl) return;
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!text || text === "...") {
      statusEl.textContent = "";
      statusEl.hidden = true;
      return;
    }
    statusEl.textContent = `Status: ${text}`;
    statusEl.hidden = false;
  };

  const asMenu = Boolean(options.asMenu);
  closeAgentMenu();
  closeAgentProfileWindow();
  profilePanelMenuMode = asMenu;
  if (asMenu) {
    view = "grid";
  } else {
    view = "profile";
  }

  profileData = null;
  profileAgent = agent;
  if (activeChatEventContext && activeChatEventContext.agentName !== agent.name) {
    clearActiveChatEventContext();
  }
  fetchAgentModelInfo(agent.name);

  const panel = document.getElementById("profile-panel");
  panel.classList.add("visible");
  panel.classList.toggle("menu-mode", asMenu);
  setTracePanelVisible(true);

  if (asMenu) {
    profilePanelMenuAnchor = options.anchor || getAgentAnchorClient(agent) || profilePanelMenuAnchor;
    if (profilePanelMenuAnchor) {
      positionProfilePanelMenu(profilePanelMenuAnchor.x, profilePanelMenuAnchor.y);
      requestAnimationFrame(() => {
        if (!profilePanelMenuAnchor || !isProfilePanelMenuOpen()) return;
        positionProfilePanelMenu(profilePanelMenuAnchor.x, profilePanelMenuAnchor.y);
      });
    }
  } else {
    profilePanelMenuAnchor = null;
    panel.style.left = "";
    panel.style.top = "";
  }

  document.getElementById("profile-name").textContent = agent.name;
  document.getElementById("profile-tagline").textContent = agent.tagline;

  const badge = document.getElementById("profile-type-badge");
  badge.textContent = agent.type;
  badge.setAttribute("data-type", agent.type);

  const dot = document.getElementById("profile-state-dot");
  dot.className = `state-dot ${agent.state}`;

  // Draw sprite on profile canvas
  const profileCanvas = document.getElementById("profile-sprite");
  const pctx = profileCanvas.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  pctx.clearRect(0, 0, 128, 128);
  const sprite = spriteImages[agent.name] || generatePlaceholderSprite(agent);
  pctx.drawImage(sprite, 0, 0, 128, 128);

  // Bubble
  document.getElementById("profile-bubble-text").textContent = agent.bubble;
  setProfileStatusInfo(agent.bubble);

  // Chat header + placeholder can reflect active event-reference context.
  updateChatInputContextUI();

  // Show upload button only for photoblogger
  const uploadBtn = document.getElementById("photo-upload-btn");
  if (uploadBtn) {
    uploadBtn.style.display = agent.name === "photoblogger" ? "" : "none";
  }
  clearPendingUpload();

  // Chat history + trace panel
  rebuildTraceHistory(agent.name);
  renderChatMessages(agent.name);
  loadSessionHistory(agent.name); // async: populates from Honcho if local is empty
  renderTraceEntries(agent.name);

  // Build invite grid (pair with other agents)
  const inviteGrid = document.getElementById("invite-agent-grid");
  inviteGrid.innerHTML = "";
  for (const other of getVisibleAgents()) {
    if (other.name === agent.name) continue;
    const btn = document.createElement("button");
    btn.className = "invite-agent-btn";
    btn.setAttribute("data-type", other.type);
    btn.textContent = other.name;
    btn.addEventListener("click", () => {
      // Open campfire with just these two agents
      hideProfile();
      campfireSelected = new Set([agent.name, other.name]);
      campfireMessages = [];
      campfireSessionId = null;
      showCampfire();
    });
    inviteGrid.appendChild(btn);
  }

  // Focus chat input
  if (!asMenu) {
    setTimeout(() => {
      document.getElementById("chat-input").focus();
    }, 100);
  }

  // Fetch full profile data
  fetchProfile(agent.name).then((data) => {
    if (!data) return;
    if (!profileAgent || profileAgent.name !== agent.name) return;
    profileData = data;
    renderProfileStats(data);

    // Update bubble with richer data
    if (data.bubble && data.bubble !== agent.bubble) {
      document.getElementById("profile-bubble-text").textContent = data.bubble;
      setProfileStatusInfo(data.bubble);
    }
  });

  // Render basic stats from roster data while full profile loads
  renderProfileStats({
    lastRun: agent.lastRun,
    schedule: agent.schedule,
    executionTier: agent.executionTier,
  });
}

function renderProfileStats(data) {
  const container = document.getElementById("profile-stats");
  const stats = [];

  if (data.lastRun) {
    const ago = timeAgo(data.lastRun);
    stats.push({ label: "Last Run", value: ago });
  } else {
    stats.push({ label: "Last Run", value: "never", cls: "orange" });
  }

  if (data.uptimePct !== undefined && data.uptimePct !== null) {
    const cls = data.uptimePct >= 90 ? "green" : data.uptimePct >= 70 ? "orange" : "red";
    stats.push({ label: "Uptime (7d)", value: data.uptimePct.toFixed(1) + "%", cls });
  }

  if (data.budgetTier) {
    const cls = data.budgetTier === "GREEN" ? "green"
      : data.budgetTier === "YELLOW" ? "orange" : "red";
    stats.push({ label: "Budget", value: data.budgetTier, cls });
  }

  if (data.todayCostUsd !== undefined) {
    stats.push({ label: "Cost", value: "$" + data.todayCostUsd.toFixed(4) });
  }

  if (data.executionTier) {
    stats.push({ label: "Tier", value: data.executionTier });
  }

  if (data.schedule) {
    stats.push({ label: "Schedule", value: data.schedule });
  }

  if (data.totalRuns24h !== undefined) {
    stats.push({ label: "Runs (24h)", value: String(data.totalRuns24h) });
  }

  if (data.circuitOpen !== undefined) {
    const cls = data.circuitOpen ? "red" : "green";
    stats.push({
      label: "Circuit",
      value: data.circuitOpen ? "OPEN" : "closed",
      cls,
    });
  }

  container.innerHTML = stats
    .map(
      (s) =>
        `<div class="stat-cell"><div class="label">${s.label}</div><div class="value ${s.cls || ""}">${s.value}</div></div>`
    )
    .join("");
}

function hideProfile() {
  if (view === "profile") view = "grid";
  profilePanelMenuMode = false;
  profilePanelMenuAnchor = null;
  profileData = null;
  profileAgent = null;
  const panel = document.getElementById("profile-panel");
  panel.classList.remove("visible", "menu-mode");
  panel.classList.remove("trace-collapsed");
  panel.style.left = "";
  panel.style.top = "";
  document.getElementById("chat-input").blur();
}

// ---- Input Handling ----

function handleKeyDown(e) {
  // Webview intercepts Escape when open
  if (webviewOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeWebview();
    }
    return;
  }

  // Model picker intercepts all keys when open
  if (modelPickerOpen) {
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      closeModelPicker();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      modelPickerNav(-1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      modelPickerNav(1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      modelPickerSave();
      return;
    }
    e.preventDefault();
    return;
  }

  if (worldMenuOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleWorldMenu(false);
      return;
    }
    const layoutInput = document.getElementById("world-layout-json");
    if (document.activeElement === layoutInput) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return;
    }
  }

  if (settingsMenuOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleSettingsMenu(false);
      return;
    }
    const settingsRoot = document.getElementById("settings-menu");
    const active = document.activeElement;
    if (settingsRoot && active instanceof Node && settingsRoot.contains(active)) {
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      return;
    }
  }

  if (view === "grid" && (e.key === "l" || e.key === "L")) {
    const active = document.activeElement;
    const inEditable = Boolean(
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
    );
    if (!inEditable) {
      e.preventDefault();
      setEventLogCollapsed(!eventLogCollapsed);
      return;
    }
  }

  if (view === "grid" && e.key === "/") {
    const active = document.activeElement;
    const inEditable = Boolean(
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
    );
    if (!inEditable) {
      e.preventDefault();
      if (eventLogCollapsed) setEventLogCollapsed(false);
      if (!eventLogToolsOpen) setEventLogToolsOpen(true);
      const searchInput = document.getElementById("event-log-search");
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
      return;
    }
  }

  if (view === "grid" && isProfilePanelMenuOpen()) {
    const chatInput = document.getElementById("chat-input");
    if (document.activeElement === chatInput) {
      if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && !chatInput.value.trim()) {
        e.preventDefault();
        swapProfileMenuAgent(-1);
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowDown") && !chatInput.value.trim()) {
        e.preventDefault();
        swapProfileMenuAgent(1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (profileAgent) sendChat(profileAgent.name, chatInput.value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        chatInput.blur();
        hideProfile();
        return;
      }
      return;
    }

    if (e.key === "Escape" || e.key === "b" || e.key === "Backspace") {
      e.preventDefault();
      hideProfile();
      return;
    }
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      if (profileAgent) {
        const bubbleText = document.getElementById("profile-bubble-text")?.textContent;
        speakAgent(profileAgent.name, bubbleText);
      }
      return;
    }
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      setTracePanelVisible(!tracePanelVisible);
      return;
    }
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      if (profileAgent) openModelPicker(profileAgent.name);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      const name = profileAgent?.name;
      hideProfile();
      if (name) {
        campfireSelected = new Set([name]);
        campfireMessages = [];
      campfireSessionId = null;
      }
      showCampfire();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      swapProfileMenuAgent(-1);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      swapProfileMenuAgent(1);
      return;
    }
    if (chatInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      chatInput.focus();
      return;
    }
  }

  if (view === "grid" && (e.key === "Escape" || e.key === "Backspace")) {
    if (agentMenuOpen || agentProfileWindowOpen) {
      e.preventDefault();
      closeAgentMenu();
      closeAgentProfileWindow();
      return;
    }
  }

  if (view === "grid" && agentProfileWindowOpen) {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      swapMiniProfileAgent(-1);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      swapMiniProfileAgent(1);
      return;
    }
  }

  if (view === "campfire") {
    const campfireInput = document.getElementById("campfire-input");
    if (document.activeElement === campfireInput) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendCampfire(campfireInput.value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        campfireInput.blur();
        hideCampfire();
        return;
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault();
      hideCampfire();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      campfireInput.focus();
    }
    return;
  }

  if (view === "profile") {
    // Chat input takes priority when focused
    const chatInput = document.getElementById("chat-input");
    if (document.activeElement === chatInput) {
      if ((e.key === "ArrowLeft" || e.key === "ArrowUp") && !chatInput.value.trim()) {
        e.preventDefault();
        swapProfileMenuAgent(-1);
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowDown") && !chatInput.value.trim()) {
        e.preventDefault();
        swapProfileMenuAgent(1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (profileAgent) sendChat(profileAgent.name, chatInput.value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        chatInput.blur();
        hideProfile();
        return;
      }
      // Let all other keys pass through to the input
      return;
    }

    if (e.key === "Escape" || e.key === "b" || e.key === "Backspace") {
      e.preventDefault();
      hideProfile();
      return;
    }
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      if (profileAgent) {
        const bubbleText = document.getElementById("profile-bubble-text")?.textContent;
        speakAgent(profileAgent.name, bubbleText);
      }
      return;
    }
    if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      setTracePanelVisible(!tracePanelVisible);
      return;
    }
    if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      if (profileAgent) openModelPicker(profileAgent.name);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      const name = profileAgent.name;
      hideProfile();
      campfireSelected = new Set([name]);
      campfireMessages = [];
      campfireSessionId = null;
      showCampfire();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      swapProfileMenuAgent(-1);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      swapProfileMenuAgent(1);
      return;
    }
    // Focus chat input on any letter key when not already focused
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      chatInput.focus();
      // Don't prevent default so the character appears in the input
    }
    return;
  }

  // Aquarium view
  const sortedVisibleAgents = getDepthSortedAgents();
  const visibleCount = sortedVisibleAgents.length;
  const currentVisibleIndex = sortedVisibleAgents.findIndex((entry) => entry.originalIndex === selectedIndex);
  const safeVisibleIndex = currentVisibleIndex === -1 ? 0 : currentVisibleIndex;
  if (visibleCount > 0 && currentVisibleIndex === -1) {
    selectedIndex = sortedVisibleAgents[0].originalIndex;
  }

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowUp":
      e.preventDefault();
      if (visibleCount === 0) break;
      selectedIndex =
        sortedVisibleAgents[(safeVisibleIndex - 1 + visibleCount) % visibleCount].originalIndex;
      break;
    case "ArrowRight":
    case "ArrowDown":
      e.preventDefault();
      if (visibleCount === 0) break;
      selectedIndex =
        sortedVisibleAgents[(safeVisibleIndex + 1) % visibleCount].originalIndex;
      break;
    case "Enter":
      e.preventDefault();
      if (visibleCount === 0) break;
      showProfile(sortedVisibleAgents[safeVisibleIndex].agent);
      break;
    case " ":
      e.preventDefault();
      showCampfire();
      break;
  }
}

// ---- Gamepad Support ----

function pollGamepad() {
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = gamepads[0];
  if (!gp) return;

  const buttons = {};
  for (let i = 0; i < gp.buttons.length; i++) {
    buttons[i] = gp.buttons[i].pressed;
  }

  const justPressed = (idx) => buttons[idx] && !gamepadPrevButtons[idx];

  if (settingsMenuOpen) {
    if (justPressed(1) || justPressed(8)) toggleSettingsMenu(false);
    gamepadPrevButtons = { ...buttons };
    return;
  }

  if (view === "campfire") {
    if (justPressed(1) || justPressed(8)) hideCampfire();
    if (justPressed(0)) {
      const input = document.getElementById("campfire-input");
      if (input.value.trim()) sendCampfire(input.value);
    }
    gamepadPrevButtons = { ...buttons };
    return;
  }

  if (view === "grid" && isProfilePanelMenuOpen()) {
    if (justPressed(1) || justPressed(8)) hideProfile();
    if (justPressed(2) && profileAgent) {
      const bubbleText = document.getElementById("profile-bubble-text")?.textContent;
      speakAgent(profileAgent.name, bubbleText);
    }
    if (justPressed(14) || justPressed(12)) swapProfileMenuAgent(-1);
    if (justPressed(15) || justPressed(13)) swapProfileMenuAgent(1);
    if (justPressed(0) && profileAgent) {
      const input = document.getElementById("chat-input");
      if (input.value.trim() || pendingUpload) {
        sendChat(profileAgent.name, input.value);
      }
    }
    if (justPressed(9) && profileAgent) {
      const name = profileAgent.name;
      hideProfile();
      campfireSelected = new Set([name]);
      campfireMessages = [];
      campfireSessionId = null;
      showCampfire();
    }

    gamepadPrevButtons = { ...buttons };
    return;
  }

  if (view === "profile") {
    if (justPressed(1) || justPressed(8)) hideProfile();
    // X button = SPEAK
    if (justPressed(2) && profileAgent) {
      const bubbleText = document.getElementById("profile-bubble-text")?.textContent;
      speakAgent(profileAgent.name, bubbleText);
    }
    // A button = send chat
    if (justPressed(0) && profileAgent) {
      const input = document.getElementById("chat-input");
      if (input.value.trim()) {
        sendChat(profileAgent.name, input.value);
      }
    }
  } else {
    if (justPressed(14)) handleKeyDown({ key: "ArrowLeft", preventDefault() {} });
    if (justPressed(15)) handleKeyDown({ key: "ArrowRight", preventDefault() {} });
    if (justPressed(12)) handleKeyDown({ key: "ArrowUp", preventDefault() {} });
    if (justPressed(13)) handleKeyDown({ key: "ArrowDown", preventDefault() {} });
    if (justPressed(0)) handleKeyDown({ key: "Enter", preventDefault() {} });
    if (justPressed(9)) showCampfire(); // START button

    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    const threshold = 0.5;
    if (ax < -threshold && !gamepadPrevButtons["axL"]) {
      handleKeyDown({ key: "ArrowLeft", preventDefault() {} });
      buttons["axL"] = true;
    } else if (ax >= -threshold) {
      buttons["axL"] = false;
    }
    if (ax > threshold && !gamepadPrevButtons["axR"]) {
      handleKeyDown({ key: "ArrowRight", preventDefault() {} });
      buttons["axR"] = true;
    } else if (ax <= threshold) {
      buttons["axR"] = false;
    }
    if (ay < -threshold && !gamepadPrevButtons["axU"]) {
      handleKeyDown({ key: "ArrowUp", preventDefault() {} });
      buttons["axU"] = true;
    } else if (ay >= -threshold) {
      buttons["axU"] = false;
    }
    if (ay > threshold && !gamepadPrevButtons["axD"]) {
      handleKeyDown({ key: "ArrowDown", preventDefault() {} });
      buttons["axD"] = true;
    } else if (ay <= threshold) {
      buttons["axD"] = false;
    }
  }

  gamepadPrevButtons = { ...buttons };
}

// ---- Utilities ----

function timeAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m ago";
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Status Bar ----

function updateStatusBar() {
  const info = document.getElementById("status-info");
  if (!info) return;
  if (agents.length === 0) {
    info.textContent = "loading...";
    return;
  }
  const visibleSorted = getDepthSortedAgents();
  if (visibleSorted.length === 0) {
    info.textContent = "all agents hidden";
    return;
  }
  const selectedOffset = visibleSorted.findIndex((entry) => entry.originalIndex === selectedIndex);
  const selectedSlot = selectedOffset === -1 ? 0 : selectedOffset;
  const selected = visibleSorted[selectedSlot]?.agent;
  if (!selected) return;
  const working = getVisibleAgents().filter((agent) => agent.state === "working").length;
  const stateStr = working > 0 ? `${working} running` : "idle";
  info.textContent = `${selectedSlot + 1}/${visibleSorted.length} ${selected.type} \u00B7 ${stateStr}`;
}

// ---- Profile Sprite Animation ----

function animateProfileSprite(timestamp) {
  const panel = document.getElementById("profile-panel");
  const isMenuVisible = Boolean(profilePanelMenuMode && panel && panel.classList.contains("visible"));
  if ((view !== "profile" && !isMenuVisible) || !profileAgent) return;

  const profileCanvas = document.getElementById("profile-sprite");
  if (!profileCanvas) return;
  const pctx = profileCanvas.getContext("2d");
  pctx.imageSmoothingEnabled = false;
  pctx.clearRect(0, 0, 128, 128);

  const sprite = spriteImages[profileAgent.name] || generatePlaceholderSprite(profileAgent);

  // Gentle breathing for profile sprite
  let yOff = 0;
  if (profileAgent.state === "working") {
    yOff = Math.sin(timestamp / 200) * 4;
  } else {
    yOff = Math.sin(timestamp / 1000) * 2;
  }

  pctx.drawImage(sprite, 0, Math.floor(yOff), 128, 128);

  const modelMeta = agentModelInfo[profileAgent.name];
  if (modelMeta?.modelId) {
    const iconImage = getModelIconImage(modelMeta);
    if (!iconImage && !modelMeta.label) return;

    const iconSize = 36;
    const orbitRadius = 4;
    const orbitX = 86 + Math.cos(timestamp * 0.0018) * orbitRadius;
    const orbitY = 28 + Math.sin(timestamp * 0.0026) * (orbitRadius * 0.55);
    const x = Math.floor(orbitX - iconSize / 2);
    const y = Math.floor(orbitY - iconSize / 2);

    pctx.save();
    pctx.imageSmoothingEnabled = false;
    pctx.globalAlpha = 0.96;

    if (iconImage) {
      pctx.drawImage(iconImage, x, y, iconSize, iconSize);
    } else if (modelMeta.label) {
      pctx.font = "12px 'Departure Mono', 'Noto Emoji', monospace";
      pctx.textAlign = "left";
      pctx.textBaseline = "top";
      pctx.shadowColor = "rgba(0, 0, 0, 0.6)";
      pctx.shadowBlur = 0;
      pctx.shadowOffsetX = 1;
      pctx.shadowOffsetY = 1;
      pctx.fillStyle = "#b5ccff";
      pctx.fillText(modelMeta.label.slice(0, 6), x + 3, y + 11);
    }

    pctx.restore();
  }
}

// ---- Model Picker ----

async function openModelPicker(agentName) {
  modelPickerAgent = agentName;
  modelPickerOpen = true;

  // Fetch current model info from server
  try {
    const res = await fetch(`/api/agent/${agentName}/model`);
    if (res.ok) {
      const info = await res.json();
      setAgentModelInfo(agentName, info);
      agentModelFetchState[agentName] = "loaded";
      modelPickerCurrentModel = info.model;
      // Set index to current model
      const idx = MODEL_REGISTRY.findIndex((m) => m.modelId === info.model);
      modelPickerIndex = idx >= 0 ? idx : 0;
    } else {
      agentModelFetchState[agentName] = "error";
      modelPickerCurrentModel = null;
      modelPickerIndex = 0;
    }
  } catch {
    agentModelFetchState[agentName] = "error";
    modelPickerCurrentModel = null;
    modelPickerIndex = 0;
  }

  const picker = document.getElementById("model-picker");
  picker.hidden = false;

  document.getElementById("model-picker-agent").textContent = agentName;
  updateModelPickerDisplay();
}

function closeModelPicker() {
  modelPickerOpen = false;
  modelPickerAgent = null;
  const picker = document.getElementById("model-picker");
  picker.hidden = true;
}

// ---- Webview overlay ----
let webviewOpen = false;
let webviewUrl = null;

function openWebview(url, title) {
  const overlay = document.getElementById("webview-overlay");
  const frame = document.getElementById("webview-frame");
  const titleEl = document.getElementById("webview-title");
  webviewUrl = url;
  webviewOpen = true;
  titleEl.textContent = title || new URL(url).hostname;
  frame.src = url;
  overlay.hidden = false;
}

function closeWebview() {
  const overlay = document.getElementById("webview-overlay");
  const frame = document.getElementById("webview-frame");
  frame.src = "about:blank";
  overlay.hidden = true;
  webviewOpen = false;
  webviewUrl = null;
}

function updateModelPickerDisplay() {
  const model = MODEL_REGISTRY[modelPickerIndex];
  if (!model) return;

  document.getElementById("model-picker-img").src = model.icon;
  document.getElementById("model-picker-name").textContent = model.name;

  // Model ID + tool use indicator
  const idEl = document.getElementById("model-picker-id");
  idEl.textContent = model.modelId;
  idEl.setAttribute("data-tools", model.toolUse ? "yes" : "no");

  // Active highlight on the card
  const card = document.querySelector(".model-picker-card");
  if (model.modelId === modelPickerCurrentModel) {
    card.classList.add("active");
  } else {
    card.classList.remove("active");
  }
  card.setAttribute("data-tools", model.toolUse ? "yes" : "no");

  // Dot indicators
  const dotsEl = document.getElementById("model-picker-dots");
  dotsEl.innerHTML = "";
  for (let i = 0; i < MODEL_REGISTRY.length; i++) {
    const dot = document.createElement("span");
    dot.className = "model-picker-dot";
    if (i === modelPickerIndex) dot.classList.add("current");
    if (MODEL_REGISTRY[i].modelId === modelPickerCurrentModel) dot.classList.add("active");
    if (!MODEL_REGISTRY[i].toolUse) dot.classList.add("no-tools");
    dotsEl.appendChild(dot);
  }
}

function modelPickerNav(dir) {
  modelPickerIndex = (modelPickerIndex + dir + MODEL_REGISTRY.length) % MODEL_REGISTRY.length;
  updateModelPickerDisplay();
}

async function modelPickerSave() {
  const model = MODEL_REGISTRY[modelPickerIndex];
  if (!model || !modelPickerAgent) return;

  try {
    const res = await fetch(`/api/agent/${modelPickerAgent}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.modelId }),
    });
    if (res.ok) {
      const info = await res.json();
      setAgentModelInfo(modelPickerAgent, info);
      agentModelFetchState[modelPickerAgent] = "loaded";
      modelPickerCurrentModel = info.model;
      updateModelPickerDisplay();
      logAgentEvent(`${modelPickerAgent} model set to ${model.name}`, {
        agentName: modelPickerAgent,
        kind: "state",
        dedupeKey: `model-set:${modelPickerAgent}:${info.model}`,
        cooldownMs: 800,
      });
      triggerHapticFeedback([16, 22, 12]);
      closeModelPicker();
    }
  } catch (err) {
    console.error("[model-picker] save failed:", err);
  }
}

function initModelPicker() {
  document.getElementById("model-picker-prev").addEventListener("click", () => modelPickerNav(-1));
  document.getElementById("model-picker-next").addEventListener("click", () => modelPickerNav(1));
  document.getElementById("model-picker-save").addEventListener("click", () => modelPickerSave());
  document.getElementById("model-picker-cancel").addEventListener("click", () => closeModelPicker());
}

function initWebview() {
  document.getElementById("webview-close").addEventListener("click", closeWebview);
  document.getElementById("webview-external").addEventListener("click", () => {
    if (webviewUrl) window.open(webviewUrl, "_blank", "noopener");
  });
}

// ---- Main Loop ----

async function init() {
  resize();
  loadUiSettings();
  loadTraceHistory();
  applyCampfireLabelToUi(true);
  window.addEventListener("resize", resize);
  document.addEventListener("keydown", handleKeyDown);
  canvas.addEventListener("click", handleCanvasClick);
  canvas.addEventListener("mousemove", handleCanvasPointerMove);
  canvas.addEventListener("mouseleave", () => {
    canvas.style.cursor = "default";
  });
  exposeWorldControls();
  initWorldMenu();
  initSettingsMenu();
  initAgentMenu();
  initAgentProfileWindow();
  initModelPicker();
  initWebview();
  primeModelIcons();

  const traceToggleBtn = document.getElementById("trace-toggle");
  if (traceToggleBtn) {
    traceToggleBtn.addEventListener("click", () => {
      setTracePanelVisible(!tracePanelVisible);
    });
  }
  const eventLogToggleBtn = document.getElementById("event-log-toggle");
  if (eventLogToggleBtn) {
    eventLogToggleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setEventLogCollapsed(!eventLogCollapsed);
    });
  }
  const eventLogToolsToggleBtn = document.getElementById("event-log-tools-toggle");
  if (eventLogToolsToggleBtn) {
    eventLogToolsToggleBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = !eventLogToolsOpen;
      setEventLogToolsOpen(next);
      if (next) {
        const searchInput = document.getElementById("event-log-search");
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    });
  }
  const eventLogSearchInput = document.getElementById("event-log-search");
  if (eventLogSearchInput) {
    eventLogSearchInput.addEventListener("input", () => {
      eventLogSearchQuery = eventLogSearchInput.value || "";
      queueEventSearch(false);
    });
    eventLogSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        eventLogSearchQuery = eventLogSearchInput.value || "";
        queueEventSearch(true);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        clearEventSearch();
        eventLogSearchInput.blur();
      }
    });
  }
  const eventLogKindSelect = document.getElementById("event-log-kind");
  if (eventLogKindSelect) {
    eventLogKindSelect.addEventListener("change", () => {
      eventLogSearchKind = eventLogKindSelect.value || "all";
      eventLogLastMarkup = "";
      if (isEventSearchMode()) {
        queueEventSearch(true);
      } else {
        renderEventLog();
      }
    });
  }
  const eventLogSemanticBtn = document.getElementById("event-log-semantic");
  if (eventLogSemanticBtn) {
    eventLogSemanticBtn.addEventListener("click", (event) => {
      event.preventDefault();
      eventLogSearchSemantic = !eventLogSearchSemantic;
      eventLogLastMarkup = "";
      if (isEventSearchMode()) {
        queueEventSearch(true);
      } else {
        renderEventLog();
      }
    });
  }
  const eventLogLiveBtn = document.getElementById("event-log-live");
  if (eventLogLiveBtn) {
    eventLogLiveBtn.addEventListener("click", (event) => {
      event.preventDefault();
      clearEventSearch();
    });
  }
  const eventLogEntriesEl = document.getElementById("event-log-entries");
  if (eventLogEntriesEl) {
    eventLogEntriesEl.addEventListener("click", handleEventLogClick);
  }
  setTracePanelVisible(true);
  await loadPersistedEvents();
  renderEventLog();
  logAgentEvent("event stream online", {
    kind: "info",
    dedupeKey: "event-stream-online",
    cooldownMs: 600000,
  });
  window.addEventListener("pagehide", flushEventsOnPageHide);
  window.addEventListener("beforeunload", flushEventsOnPageHide);

  document.addEventListener("click", (event) => {
    if (!isProfilePanelMenuOpen()) return;
    const panel = document.getElementById("profile-panel");
    const target = event.target;
    if (!(panel && target instanceof Node)) return;
    if (target === canvas) return;
    if (!panel.contains(target)) hideProfile();
  });

  // Wire up chat send button
  document.getElementById("chat-send").addEventListener("click", () => {
    if (profileAgent) {
      const input = document.getElementById("chat-input");
      sendChat(profileAgent.name, input.value);
    }
  });

  // Wire up photo upload
  const photoUploadBtn = document.getElementById("photo-upload-btn");
  const photoFileInput = document.getElementById("photo-file-input");
  const photoRemoveBtn = document.getElementById("photo-upload-remove");

  photoUploadBtn.addEventListener("click", () => {
    if (pendingUpload) {
      clearPendingUpload();
    } else {
      photoFileInput.click();
    }
  });

  photoFileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      photoUploadBtn.textContent = "...";
      photoUploadBtn.disabled = true;
      const data = await uploadPhoto(file);
      showUploadPreview(file, data);
      photoUploadBtn.textContent = "IMG";
      photoUploadBtn.disabled = false;
    } catch (err) {
      console.error("[upload]", err);
      photoUploadBtn.textContent = "IMG";
      photoUploadBtn.disabled = false;
    }

    // Reset file input so same file can be selected again
    photoFileInput.value = "";
  });

  photoRemoveBtn.addEventListener("click", () => {
    clearPendingUpload();
  });

  // Wire up campfire buttons
  document.getElementById("campfire-send").addEventListener("click", () => {
    const input = document.getElementById("campfire-input");
    sendCampfire(input.value);
  });
  document.getElementById("campfire-all").addEventListener("click", () => {
    campfireSelected.clear();
    getVisibleAgents().forEach((agent) => campfireSelected.add(agent.name));
    document.querySelectorAll(".campfire-agent-btn").forEach((button) => button.classList.add("selected"));
    updateCampfireSession();
  });
  document.getElementById("campfire-none").addEventListener("click", () => {
    campfireSelected.clear();
    document.querySelectorAll(".campfire-agent-btn").forEach((b) => b.classList.remove("selected"));
    updateCampfireSession();
  });

  // DJ boombox + profile trace controls
  const djBoomboxPlayBtn = document.getElementById("dj-boombox-play");
  const djBoomboxPauseBtn = document.getElementById("dj-boombox-pause");
  const djTracePlayBtn = document.getElementById("dj-trace-play");
  const djTracePauseBtn = document.getElementById("dj-trace-pause");
  const djTrackRequestBtn = document.getElementById("dj-track-request");
  const djTrackQueryBtn = document.getElementById("dj-track-query");
  const djTrackInput = document.getElementById("dj-track-input");

  if (djBoomboxPlayBtn) {
    djBoomboxPlayBtn.addEventListener("click", () => {
      void runDjCommand("play");
    });
  }
  if (djBoomboxPauseBtn) {
    djBoomboxPauseBtn.addEventListener("click", () => {
      void runDjCommand("pause");
    });
  }
  if (djTracePlayBtn) {
    djTracePlayBtn.addEventListener("click", () => {
      void runDjCommand("play");
    });
  }
  if (djTracePauseBtn) {
    djTracePauseBtn.addEventListener("click", () => {
      void runDjCommand("pause");
    });
  }
  if (djTrackRequestBtn) {
    djTrackRequestBtn.addEventListener("click", () => {
      void runDjCommand("request", djTrackInput?.value || "");
    });
  }
  if (djTrackQueryBtn) {
    djTrackQueryBtn.addEventListener("click", () => {
      void runDjCommand("query", djTrackInput?.value || "");
    });
  }
  if (djTrackInput) {
    djTrackInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        void runDjCommand("query", djTrackInput.value);
      } else {
        void runDjCommand("request", djTrackInput.value);
      }
    });
  }
  syncDjUiState();

  // Fetch initial data
  await fetchRoster();
  logAgentEvent(`${agents.length} agents loaded`, {
    kind: "info",
    dedupeKey: "agents-loaded",
    cooldownMs: 600000,
  });

  // Hide loading screen
  document.getElementById("loading").classList.add("hidden");

  // Start render loop
  requestAnimationFrame(loop);
}

function loop(timestamp) {
  const delta = lastTimestamp ? timestamp - lastTimestamp : 16;
  lastTimestamp = timestamp;
  void pollServerEvents();
  syncDjUiState();
  syncEventLogVisibility();
  if (timestamp - eventLogLastRepaint > EVENT_LOG_REPAINT_MS && shouldAutoRepaintEventLog()) {
    eventLogLastRepaint = timestamp;
    renderEventLog();
  }
  if (eventUploadQueue.length > 0) {
    void flushEventUploads();
  }

  // Refresh data periodically
  if (timestamp - lastDataFetch > DATA_REFRESH_MS) {
    lastDataFetch = timestamp;
    fetchRoster();
  }

  if (view === "grid") {
    updateAquarium(delta);
    drawAquarium(timestamp);
    syncFloatingMenusToAgents();
    if (isProfilePanelMenuOpen()) {
      document.getElementById("bubble-overlay")?.classList.remove("visible");
    } else {
      updateBubble(timestamp);
    }
    animateProfileSprite(timestamp);
    updateStatusBar();
    pollGamepad();
  } else if (view === "profile") {
    animateProfileSprite(timestamp);
    pollGamepad();
  }

  requestAnimationFrame(loop);
}

// ---- Boot ----

init();
