# COSMANIA DEX

Pokedex-style interface for observing, conversing with, and orchestrating a multi-agent AI framework. Built on Mistral, remembered with Honcho, traced with W&B Weave.

**Mistral Worldwide Hackathon 2026 -- NYC**

## What It Is

Cosmania is a multi-agent framework where specialized AI agents (coder, dreamer, observer, photoblogger, DJ, etc.) run on schedules, collaborate in group sessions, and maintain persistent memory. **COSMANIA DEX** is the frontend -- a retro pixel-art control surface for all of them.

- Canvas 2D grid with 32x32 pixel sprites -- agents wander, seek each other, display speech bubbles
- Direct chat with any agent via Mistral with full tool execution
- Group campfire conversations with autonomous agent-to-agent dialogue
- Photo uploads analyzed by Pixtral, ingested to catalog, published to Cloudflare Pages
- Per-agent model hot-swapping through a carousel picker
- Real-time event log with search and filtering
- Gamepad support (Anbernic d-pad) + keyboard fallback

## Stack

| Layer | Tech | Role |
|-------|------|------|
| LLM | **Mistral API** | Agent chat, tool calling, group orchestration |
| Vision | **Pixtral Large** | Photo analysis with sharp preprocessing |
| Memory | **Honcho** | Persistent sessions, cross-agent context, dialectic reasoning |
| Tracing | **W&B Weave** | Full observability -- inputs, outputs, latency, tokens |
| Runtime | **Bun** | Server, static files, API |
| Frontend | Vanilla JS + Canvas 2D | Zero-framework, zero-build-step |
| Deploy | **Cloudflare Pages** | Photoblog static site |

## Quick Start

```bash
# Clone
git clone https://github.com/erosika/cosmania-dex.git
cd cosmania-dex

# Install
bun install

# Configure
cp .env.example .env
# Set MISTRAL_API_KEY (required)
# Set COSMANIA_URL to point to your Cosmania instance
# Optionally set HONCHO_API_KEY, WANDB_API_KEY

# Run
bun run server/main.ts
# Open http://localhost:3333
```

## Architecture

```
client/              Pokedex UI
  index.html           single-page canvas app
  game.js              renderer, input, data fetching
  style.css            dark theme (Departure Mono + New York)
  sprites/             32x32 agent PNGs + 192px model icons

server/              Bun.serve backend
  main.ts              static server, API, group autonomy
  mistral.ts           Mistral chat, tools, group orchestration
  honcho.ts            Honcho memory integration
  uploads.ts           photo upload registry (disk-persistent)
  weave.ts             W&B Weave tracing (graceful degradation)
```

## Mistral Integration

Every agent conversation goes through Mistral with tool calling. Agents have real tools executed server-side: memory read/write, photo analysis, blog publishing, catalog stats. Group sessions orchestrate multi-agent turns with per-agent system prompts and capability awareness.

Models used:
- `mistral-small-latest` -- default agent conversations
- `pixtral-large-latest` -- photo vision analysis
- Runtime-swappable via model picker (9 models available)

## Honcho Memory

Agents maintain persistent memory across sessions via [Honcho](https://honcho.dev). Each conversation maps to a Honcho session. Before responding, agents load cross-agent context and relevant conclusions. Group sessions are recorded so agents recall previous discussions when reconvening.

## W&B Weave

All Mistral calls are traced with `weave.op()`. If `WANDB_API_KEY` is not set or invalid, tracing silently disables with zero overhead.

## Env Vars

```
MISTRAL_API_KEY=              # Required -- Mistral API
COSMANIA_URL=http://localhost:8080  # Cosmania health server
DEX_PORT=3333                 # Server port
HONCHO_API_KEY=               # Persistent agent memory
WANDB_API_KEY=                # W&B Weave tracing
DISCORD_TOKEN=                # Discord bot (optional)
ELEVENLABS_API_KEY=           # Voice synthesis (optional)
```

## Controls

| Key | Action |
|-----|--------|
| Arrow keys | Navigate grid |
| Enter | Select agent |
| Escape | Back |
| S | Speak |
| T | Toggle trace |
| M | Model picker |
| Space | Campfire |
| Tab | Switch views |

Gamepad: D-pad navigate, A select, B back, X speak, L1/R1 switch views, START standup.

## License

MIT
