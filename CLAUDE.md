# COSMANIA DEX

Pokedex-style interface for the Cosmania agent framework.
Hackathon submission for Mistral Worldwide Hackathon 2026.

## Runtime

- Bun, strict ESM, TypeScript (server + discord)
- Vanilla JS + Canvas 2D (client -- no framework)
- Use `bun` for all package management

## Architecture

```
client/          -- static Pokedex UI (served by Bun)
  index.html       single-page canvas app
  game.js          renderer, input, WebSocket, data fetching
  style.css        dark theme, Departure Mono + New York
  sprites/         32x32 agent pixel art PNGs

server/          -- Bun.serve backend
  main.ts          static file server + proxy to Cosmania /dex/*
  mistral.ts       Mistral chat for agent conversations (Phase 2)
  voice.ts         ElevenLabs TTS per agent (Phase 3)
  weave.ts         W&B Weave tracing (Phase 4)

discord/         -- Discord bot
  bot.ts           Discord.js bot, one webhook per agent
  commands.ts      slash commands (/standup, /ask, /status)
  channels.ts      channel setup + auto-post logic
```

## Cosmania API (upstream)

DEX server proxies these endpoints from the running Cosmania instance:
- `GET /dex/agents` -- full agent roster (grid view data)
- `GET /dex/agents/:name` -- detailed agent profile
- `GET /dex/agents/:name/bubble` -- speech bubble text

Set `COSMANIA_URL` env to point to the Cosmania health server.

## Env Vars

```
DEX_PORT=3333                 # server port
COSMANIA_URL=http://localhost:8080  # Cosmania health server
MISTRAL_API_KEY=              # for agent conversations
ELEVENLABS_API_KEY=           # for voice synthesis
WANDB_API_KEY=                # for W&B Weave tracing (auto-enabled when set)
DISCORD_TOKEN=                # Discord bot token
DISCORD_GUILD_ID=             # Target Discord server
```

## Design

- Canvas 2D with `image-rendering: pixelated`
- True black background (#000000)
- Departure Mono for all UI text
- New York (serif) for speech bubbles and descriptions
- Type colors: infrastructure=#7eb8f6, creative=#bc8cff, production=#e6a855, embodied=#f0a0b0
- 0px border-radius on all structural elements
- Gamepad API for Anbernic d-pad input
- Keyboard fallback for desktop

## Input Mapping

| Anbernic (Gamepad) | Keyboard | Action |
|-------------------|----------|--------|
| D-pad | Arrow keys | Navigate grid |
| A | Enter | Select agent |
| B | Escape | Back |
| X | S | Speak |
| L1/R1 | Tab | Switch views |
| START | Space | Standup |
