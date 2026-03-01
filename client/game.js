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
const EVENT_UPLOAD_BATCH_MS = 1200;
const EVENT_UPLOAD_MAX_BATCH = 36;
const EVENT_UPLOAD_QUEUE_LIMIT = 1200;
const EVENT_BOOTSTRAP_LOAD_LIMIT = 180;


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
let chatSending = false;
let pendingUpload = null; // { id, filename, path, size, contentHash, objectUrl }
let voicePlaying = false;
let currentAudio = null;
let campfireSelected = new Set(); // agent names selected for campfire
let campfireMessages = []; // { agent, message, type }
let campfireSending = false;
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
let tracePanelVisible = true;

// Model picker state
let modelPickerOpen = false;
let modelPickerIndex = 0;
let modelPickerAgent = null;
let modelPickerCurrentModel = null; // model ID currently active for the agent
let agentModelInfo = {}; // per-agent model metadata for badges
let agentModelFetchState = {}; // per-agent: "loading" | "loaded" | "error"
let eventLogEntries = []; // [{ ts, time, message, kind }]
let eventLogLastByKey = {}; // dedupe key -> timestamp
let eventLogCollapsed = false;
let eventLogLastRepaint = 0;
let eventLogLastMarkup = "";
let eventLogSearchQuery = "";
let eventLogSearchSemantic = true;
let eventLogSearchKind = "all";
let eventLogSearchResults = null; // null when no active query; [] when queried with no matches
let eventLogSearchInFlight = false;
let eventLogSearchDebounceTimer = null;
let eventLogSearchSeq = 0;
let eventUploadQueue = []; // events pending persistence POST /api/events
let eventUploadInFlight = false;
let eventUploadLastSentAt = 0;

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

function setAgentModelInfo(agentName, info) {
  if (!agentName || !info || !info.model) {
    agentModelInfo[agentName] = { modelId: "", label: "", isOverride: false };
    return;
  }
  agentModelInfo[agentName] = {
    modelId: info.model,
    label: getModelBadgeLabel(info.model),
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

function renderEventLog() {
  const panel = document.getElementById("event-log-panel");
  const container = document.getElementById("event-log-entries");
  const toggleBtn = document.getElementById("event-log-toggle");
  const searchInput = document.getElementById("event-log-search");
  const kindSelect = document.getElementById("event-log-kind");
  const semanticBtn = document.getElementById("event-log-semantic");
  if (!panel || !container) return;

  const shouldShow = shouldShowEventLog();
  panel.hidden = !shouldShow;
  if (!shouldShow) return;

  panel.classList.toggle("collapsed", eventLogCollapsed);
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

  if (toggleBtn) {
    toggleBtn.textContent = eventLogCollapsed ? ">" : "<";
    toggleBtn.setAttribute("aria-expanded", eventLogCollapsed ? "false" : "true");
    toggleBtn.setAttribute("aria-label", eventLogCollapsed ? "Expand event log" : "Collapse event log");
  }

  if (eventLogCollapsed) return;

  const now = Date.now();
  const searchMode = isEventSearchMode();
  const visibleEntries = eventRowsForRender(now);

  if (!visibleEntries.length) {
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

  const previousScrollTop = container.scrollTop;
  const previousScrollHeight = container.scrollHeight;
  const stickToTop = previousScrollTop <= EVENT_LOG_SCROLL_TOP_STICKY_PX;
  const markup = visibleEntries
    .map((entry) => {
      const age = now - entry.ts;
      const fadeProgress = searchMode || age <= EVENT_LOG_FADE_START_MS
        ? 0
        : Math.min(1, (age - EVENT_LOG_FADE_START_MS) / (EVENT_LOG_MAX_AGE_MS - EVENT_LOG_FADE_START_MS));
      const alpha = Math.max(0.08, 1 - fadeProgress);
      const agentLabel = entry.agentName
        ? `<span class="event-log-agent">${escapeHtml(entry.agentName)}</span>`
        : "";
      return `<div class="event-log-entry" data-kind="${escapeHtml(entry.kind)}" style="opacity:${alpha.toFixed(3)}"><span class="event-log-time">${entry.time}</span><span class="event-log-text">${agentLabel}${escapeHtml(entry.message)}</span></div>`;
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
      eventLogLastMarkup = "";
    }
  } catch {
    // best effort only
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

async function fetchRoster() {
  try {
    const res = await fetch("/dex/agents");
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
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
        }
      }
      agents = data;
      placeholderSprites = {};
      primeRosterSprites();
      for (const rosterAgent of agents) {
        if (!agentModelFetchState[rosterAgent.name]) {
          fetchAgentModelInfo(rosterAgent.name);
        }
      }
    }
  } catch (e) {
    console.warn("[dex] Failed to fetch roster:", e.message);
    if (agents.length === 0) {
      agents = generateFallbackRoster();
      primeRosterSprites();
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

function getDepthSortedAgents() {
  return [...agents]
    .map((agent, originalIndex) => ({ agent, originalIndex }))
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
  return agents.find((agent) => agent.name === name) || null;
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
  if (!profileVisible || !agents.length) return;

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
  if (!bodyEl || !agent) return;
  const runLabel = agent.lastRun ? timeAgo(agent.lastRun) : "never";
  bodyEl.textContent = `${agent.type} | ${agent.state} | run ${runLabel}`;
}

function openAgentMenu(agent, anchorClientX, anchorClientY) {
  const menu = document.getElementById("agent-menu");
  const nameEl = document.getElementById("agent-menu-name");
  if (!menu || !nameEl) return;

  agentMenuOpen = true;
  agentMenuAgentName = agent.name;
  nameEl.textContent = agent.name;
  updateAgentMenuSummary(agent);
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
  if (!agents.length) return null;
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
    if (!agent) {
      closeAgentMenu();
    } else {
      updateAgentMenuSummary(agent);
      const anchor = getAgentAnchorClient(agent);
      if (anchor) positionAgentMenu(anchor.x, anchor.y);
    }
  }

  if (agentProfileWindowOpen && agentProfileWindowAgentName) {
    const agent = getAgentByName(agentProfileWindowAgentName);
    if (!agent) {
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
    if (!liveAgent) {
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

// ---- Aquarium Rendering ----

function updateAquarium(delta) {
  ensurePixelField(canvas.width, canvas.height);
  const margin = SPRITE_DISPLAY / 2;

  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

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
      logAgentEvent(`${a.name} entered the habitat`, {
        agentName: a.name,
        kind: "social",
        dedupeKey: `spawn:${a.name}`,
        cooldownMs: 600000,
      });
    }
    if (!a.moveSpeed) a.moveSpeed = 0.028 + Math.random() * 0.015;

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
          const others = agents.filter((other) => other !== a && other.action !== "seeking_friend");
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
        a.vel.x = (dx / dist) * speed;
        a.vel.y = (dy / dist) * speed;
        a.facing = a.vel.x > 0 ? 1 : -1;
        const nextX = a.pos.x + a.vel.x * delta;
        const nextY = a.pos.y + a.vel.y * delta;
        if (!isWalkablePosition(nextX, nextY)) {
          a.action = "walking";
          a.actionTimer = 2400 + Math.random() * 3000;
          a.target = pickIntentionalTarget(true);
          a.targetAgent = null;
        }
      } else {
        // Reached friend, start chatting
        const partner = a.targetAgent?.name;
        a.action = "chatting";
        a.actionTimer = 3000 + Math.random() * 5000;
        a.vel = { x: 0, y: 0 };
        a.facing = a.targetAgent.pos.x > a.pos.x ? 1 : -1;
        a.targetAgent.facing = a.targetAgent.pos.x > a.pos.x ? -1 : 1; // Make them face each other
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

      if (dist > 5) {
        const speed = a.moveSpeed;
        a.vel.x = (dx / dist) * speed;
        a.vel.y = (dy / dist) * speed;
        a.facing = a.vel.x > 0 ? 1 : -1;
      } else {
        a.action = "idle";
        a.vel = { x: 0, y: 0 };
      }
    }

    // Apply velocity
    const nextX = a.pos.x + a.vel.x * delta;
    const nextY = a.pos.y + a.vel.y * delta;
    if (isWalkablePosition(nextX, nextY)) {
      a.pos.x = nextX;
      a.pos.y = nextY;
    } else if (a.action !== "chatting") {
      a.vel.x *= -0.35;
      a.vel.y *= -0.35;
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

    // Selected model badge: pin a compact label to the sprite corner.
    const modelMeta = agentModelInfo[agent.name];
    if (modelMeta?.isOverride && modelMeta.label) {
      const label = modelMeta.label;
      ctx.save();
      ctx.font = "7px 'JetBrains Mono', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const tagW = Math.ceil(ctx.measureText(label).width) + 5;
      const tagH = 8;
      const tagX = Math.floor(x + SPRITE_DISPLAY - tagW - 1);
      const tagY = Math.floor(drawY + 1);
      ctx.fillStyle = "rgba(8, 12, 20, 0.9)";
      ctx.fillRect(tagX, tagY, tagW, tagH);
      ctx.fillStyle = isSelected ? "#d9ebff" : "#a9c4ff";
      ctx.fillText(label, tagX + 2, tagY + 1);
      ctx.restore();
    }
    
    // Status particles: use pixel tags with pulse + short-lived motion.
    const drawIndicatorTag = (text, centerX, centerY, fg, alpha = 1) => {
      if (!text) return;
      ctx.save();
      ctx.font = "8px 'JetBrains Mono', monospace";
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
    ctx.font = "8px 'JetBrains Mono', monospace";
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
      ctx.font = "7px 'JetBrains Mono', monospace";
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
  if (agents.length === 0) {
    overlay.classList.remove("visible");
    overlay.style.opacity = "";
    return;
  }

  // Rotate through ALL agents' bubbles
  if (timestamp - lastBubbleRotate > BUBBLE_ROTATE_MS) {
    lastBubbleRotate = timestamp;
    bubbleIndex = (bubbleIndex + 1) % agents.length;
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

  const agent = agents[bubbleIndex];
  if (!agent) return;
  const bubble = typeof agent.bubble === "string" && agent.bubble.trim() ? agent.bubble.trim() : "...";
  if (activeBubbleAgentName !== agent.name || activeBubbleText !== bubble) {
    overlay.innerHTML =
      `<div class="bubble-agent">${agent.name}</div>` +
      `<div class="bubble-body">${escapeHtml(bubble)}</div>`;
    activeBubbleAgentName = agent.name;
    activeBubbleText = bubble;
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

function renderTraceEntries(agentName) {
  const container = document.getElementById("trace-entries");
  if (!container) return;

  const entries = traceHistory[agentName] || [];
  if (!traceExpandedIds[agentName]) traceExpandedIds[agentName] = new Set();
  const expanded = traceExpandedIds[agentName];

  if (entries.length === 0) {
    container.innerHTML = '<div class="trace-empty">tool calls appear here</div>';
    return;
  }

  container.innerHTML = entries.map((tc) => {
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

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;

  // Update trace status count
  const statusEl = document.getElementById("trace-status");
  if (statusEl) {
    statusEl.textContent = `${entries.length} call${entries.length !== 1 ? "s" : ""}`;
  }
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

function renderChatMessages(agentName) {
  const container = document.getElementById("chat-messages");
  const history = getHistory(agentName);

  if (history.length === 0) {
    container.innerHTML =
      '<div style="color: var(--fg-muted); font-size: 11px; font-family: var(--font-mono); padding: 8px 0; text-align: center;">say something</div>';
    return;
  }

  container.innerHTML = history
    .map((msg) => {
      if (msg.role === "user") {
        // Check for attached photo
        if (msg.photo) {
          const imgTag = msg.photo.objectUrl
            ? `<img class="chat-photo-thumb" src="${msg.photo.objectUrl}" alt="${escapeHtml(msg.photo.filename)}" />`
            : "";
          const label = `<div style="font-family: var(--font-mono); font-size: 9px; color: var(--type-production); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.06em;">img: ${escapeHtml(msg.photo.filename)}</div>`;
          return `<div class="chat-msg user">${imgTag}${label}${escapeHtml(msg.content)}</div>`;
        }
        return `<div class="chat-msg user">${escapeHtml(msg.content)}</div>`;
      }
      return `<div class="chat-msg agent" data-type="${profileAgent?.type || ""}">${escapeHtml(msg.content)}</div>`;
    })
    .join("");

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
        message,
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
      logAgentEvent(`${agentName} returned an error`, {
        agentName,
        kind: "state",
        dedupeKey: `chat-error:${agentName}:${String(data.error).slice(0, 48)}`,
        cooldownMs: 1400,
      });
    } else {
      thinkingEl.remove();
      history.push({ role: "assistant", content: data.response });
      logAgentEvent(`${agentName} replied: ${truncateText(String(data.response || "").replace(/\s+/g, " "), 68)}`, {
        agentName,
        kind: "chat",
        dedupeKey: `reply:${agentName}:${String(data.response || "").slice(0, 56)}`,
        cooldownMs: 900,
      });

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
              argsPreview: tc.args ? truncateText(JSON.stringify(tc.args), 220) : null,
              resultPreview: tc.result ? truncateText(JSON.stringify(tc.result), 220) : null,
            },
          });
        }
        renderTraceEntries(agentName);
      }
    }
  } catch (err) {
    thinkingEl.remove();
    history.push({ role: "assistant", content: `[could not reach ${agentName}]` });
    logAgentEvent(`${agentName} is unreachable`, {
      agentName,
      kind: "state",
      dedupeKey: `unreachable:${agentName}`,
      cooldownMs: 2600,
    });
  }

  chatSending = false;
  sendBtn.disabled = false;
  renderChatMessages(agentName);
  input.focus();
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

function showCampfire() {
  if (isProfilePanelMenuOpen() || view === "profile") hideProfile();
  closeAgentMenu();
  closeAgentProfileWindow();
  view = "campfire";
  const panel = document.getElementById("campfire-panel");
  panel.classList.add("visible");

  // Build agent selection grid
  const grid = document.getElementById("campfire-agent-grid");
  grid.innerHTML = "";
  for (const agent of agents) {
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

  // Default: select all if none selected
  if (campfireSelected.size === 0) {
    agents.forEach((a) => campfireSelected.add(a.name));
    grid.querySelectorAll(".campfire-agent-btn").forEach((b) => b.classList.add("selected"));
  }

  updateCampfireSession();
  renderCampfireMessages();

  setTimeout(() => {
    document.getElementById("campfire-input").focus();
  }, 100);
}

function hideCampfire() {
  view = "grid";
  document.getElementById("campfire-panel").classList.remove("visible");
  document.getElementById("campfire-input").blur();
}

function updateCampfireSession() {
  const sessionEl = document.getElementById("campfire-session");
  const names = [...campfireSelected].sort();
  if (names.length === agents.length) {
    sessionEl.textContent = "dex:campfire";
  } else if (names.length === 0) {
    sessionEl.textContent = "select agents";
  } else {
    sessionEl.textContent = "dex:" + names.join("+");
  }
}

function renderCampfireMessages() {
  const container = document.getElementById("campfire-messages");
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
        <span class="msg-body">${escapeHtml(msg.message)}</span>
      </div>`;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

async function sendCampfire(message) {
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
  campfireMessages.push({ agent: "...", message: `${selected.length} agents thinking...`, type: "thinking" });
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
      }),
    });

    const data = await res.json();
    
    // Remove thinking indicator
    campfireMessages = campfireMessages.filter((m) => m.type !== "thinking");

    // Show response
    if (data.error) {
      campfireMessages.push({ agent: "system", message: `error: ${data.error}`, type: "error" });
      logAgentEvent(`campfire error: ${truncateText(String(data.error), 72)}`, {
        kind: "state",
        dedupeKey: `campfire-error:${String(data.error).slice(0, 48)}`,
        cooldownMs: 1400,
      });
    } else if (data.messages) {
      for (const line of data.messages) {
        campfireMessages.push({ agent: line.agent, message: line.message, type: "agent" });
        logAgentEvent(`${line.agent}: ${truncateText(String(line.message).replace(/\s+/g, " "), 70)}`, {
          agentName: line.agent,
          kind: "chat",
          dedupeKey: `campfire-line:${line.agent}:${String(line.message).slice(0, 52)}`,
          cooldownMs: 700,
        });
      }
    }
  } catch (err) {
    campfireMessages = campfireMessages.filter((m) => m.type !== "thinking");
    campfireMessages.push({ agent: "system", message: "could not reach agents", type: "error" });
    logAgentEvent("campfire agents unreachable", {
      kind: "state",
      dedupeKey: "campfire-unreachable",
      cooldownMs: 2600,
    });
  }

  campfireSending = false;
  sendBtn.disabled = false;
  renderCampfireMessages();
  input.focus();
}

// ---- Profile View ----

function showProfile(agent, options = {}) {
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
  fetchAgentModelInfo(agent.name);

  const panel = document.getElementById("profile-panel");
  panel.classList.add("visible");
  panel.classList.toggle("menu-mode", asMenu);
  setTracePanelVisible(!asMenu);

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

  // Chat agent label
  const chatLabel = document.getElementById("chat-agent-label");
  if (chatLabel) {
    chatLabel.textContent = agent.name;
    chatLabel.style.color = TYPE_COLORS[agent.type] || "var(--fg-muted)";
  }

  // Show upload button only for photoblogger
  const uploadBtn = document.getElementById("photo-upload-btn");
  if (uploadBtn) {
    uploadBtn.style.display = agent.name === "photoblogger" ? "" : "none";
  }
  clearPendingUpload();

  // Chat history + trace panel
  renderChatMessages(agent.name);
  loadSessionHistory(agent.name); // async: populates from Honcho if local is empty
  renderTraceEntries(agent.name);

  // Build invite grid (pair with other agents)
  const inviteGrid = document.getElementById("invite-agent-grid");
  inviteGrid.innerHTML = "";
  for (const other of agents) {
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
      modelPickerSelect();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      modelPickerReset();
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
  const maxIndex = agents.length - 1;

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowUp":
      e.preventDefault();
      if (selectedIndex > 0) selectedIndex--;
      else selectedIndex = maxIndex;
      break;
    case "ArrowRight":
    case "ArrowDown":
      e.preventDefault();
      if (selectedIndex < maxIndex) selectedIndex++;
      else selectedIndex = 0;
      break;
    case "Enter":
      e.preventDefault();
      // Need to find the agent from the sorted list since selectedIndex tracks the visual order
      const _sortedAgents = getDepthSortedAgents();
      
      const selected = _sortedAgents.find(sa => sa.originalIndex === selectedIndex);
      if (selected && selected.agent) {
        showProfile(selected.agent);
      } else if (agents[selectedIndex]) {
        // Fallback
        showProfile(agents[selectedIndex]);
      }
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
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Status Bar ----

function updateStatusBar() {
  const info = document.getElementById("status-info");
  if (agents.length === 0) {
    info.textContent = "loading...";
    return;
  }
  const selected = agents[selectedIndex];
  if (selected) {
    const working = agents.filter((a) => a.state === "working").length;
    const stateStr = working > 0 ? `${working} running` : "idle";
    info.textContent = `${selectedIndex + 1}/${agents.length} ${selected.type} \u00B7 ${stateStr}`;
  }
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
  if (modelMeta?.isOverride && modelMeta.label) {
    pctx.save();
    pctx.font = "10px 'JetBrains Mono', monospace";
    pctx.textAlign = "left";
    pctx.textBaseline = "top";
    const w = Math.ceil(pctx.measureText(modelMeta.label).width) + 8;
    const h = 13;
    const x = 128 - w - 4;
    const y = 4;
    pctx.fillStyle = "rgba(8, 12, 20, 0.9)";
    pctx.fillRect(x, y, w, h);
    pctx.fillStyle = "#b5ccff";
    pctx.fillText(modelMeta.label, x + 4, y + 2);
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

async function modelPickerSelect() {
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
    }
  } catch (err) {
    console.error("[model-picker] select failed:", err);
  }
}

async function modelPickerReset() {
  if (!modelPickerAgent) return;

  try {
    const res = await fetch(`/api/agent/${modelPickerAgent}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    if (res.ok) {
      const info = await res.json();
      setAgentModelInfo(modelPickerAgent, info);
      agentModelFetchState[modelPickerAgent] = "loaded";
      modelPickerCurrentModel = info.model;
      const idx = MODEL_REGISTRY.findIndex((m) => m.modelId === info.model);
      if (idx >= 0) modelPickerIndex = idx;
      updateModelPickerDisplay();
      logAgentEvent(`${modelPickerAgent} model reset`, {
        agentName: modelPickerAgent,
        kind: "state",
        dedupeKey: `model-reset:${modelPickerAgent}:${info.model}`,
        cooldownMs: 800,
      });
    }
  } catch (err) {
    console.error("[model-picker] reset failed:", err);
  }
}

function initModelPicker() {
  document.getElementById("model-picker-prev").addEventListener("click", () => modelPickerNav(-1));
  document.getElementById("model-picker-next").addEventListener("click", () => modelPickerNav(1));
  document.getElementById("model-picker-select").addEventListener("click", () => modelPickerSelect());
  document.getElementById("model-picker-reset").addEventListener("click", () => modelPickerReset());
  document.getElementById("model-picker-close").addEventListener("click", () => closeModelPicker());
}

// ---- Main Loop ----

async function init() {
  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("keydown", handleKeyDown);
  canvas.addEventListener("click", handleCanvasClick);
  canvas.addEventListener("mousemove", handleCanvasPointerMove);
  canvas.addEventListener("mouseleave", () => {
    canvas.style.cursor = "default";
  });
  exposeWorldControls();
  initWorldMenu();
  initAgentMenu();
  initAgentProfileWindow();
  initModelPicker();

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
    agents.forEach((a) => campfireSelected.add(a.name));
    document.querySelectorAll(".campfire-agent-btn").forEach((b) => b.classList.add("selected"));
    updateCampfireSession();
  });
  document.getElementById("campfire-none").addEventListener("click", () => {
    campfireSelected.clear();
    document.querySelectorAll(".campfire-agent-btn").forEach((b) => b.classList.remove("selected"));
    updateCampfireSession();
  });

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
  syncEventLogVisibility();
  if (timestamp - eventLogLastRepaint > EVENT_LOG_REPAINT_MS) {
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
