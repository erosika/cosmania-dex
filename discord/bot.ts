/**
 * COSMANIA DEX -- Discord Bot
 *
 * One bot application, one webhook per agent.
 * Agents post to their designated channels via webhooks
 * so each message appears to come from a distinct identity.
 *
 * Usage:
 *   DISCORD_TOKEN=... DISCORD_GUILD_ID=... bun run discord/bot.ts
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  type TextChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  commands,
  handleStandup,
  handleAsk,
  handleStatus,
} from "./commands.ts";
import {
  ensureChannels,
  getChannelForAgent,
  postAsAgent,
} from "./channels.ts";
import { chatWithAgent, type AgentProfile } from "../server/mistral.ts";

// ----- Config -----

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const COSMANIA_URL = process.env.COSMANIA_URL || "http://localhost:8080";

if (!DISCORD_TOKEN) {
  console.error("[discord] DISCORD_TOKEN is required");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("[discord] DISCORD_GUILD_ID is required");
  process.exit(1);
}

// ----- Bot Setup -----

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let channels = new Map<string, TextChannel>();

// ----- Register Slash Commands -----

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN!);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, GUILD_ID!),
      { body: commands.map((c) => c.toJSON()) },
    );
    console.log("[discord] Slash commands registered");
  } catch (err) {
    console.error("[discord] Failed to register commands:", err);
  }
}

// ----- Event Handlers -----

client.once(Events.ClientReady, async () => {
  console.log(`[discord] Logged in as ${client.user?.tag}`);

  // Set up channels and webhooks
  const guild = client.guilds.cache.get(GUILD_ID!);
  if (!guild) {
    console.error(`[discord] Guild ${GUILD_ID} not found`);
    return;
  }

  channels = await ensureChannels(guild);
  console.log(`[discord] ${channels.size} channels ready`);

  await registerCommands();

  // Start polling for agent updates (post run summaries)
  startAgentPolling();
});

// Slash command handler
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const cmd = interaction as ChatInputCommandInteraction;

  try {
    switch (cmd.commandName) {
      case "standup":
        await handleStandup(cmd, channels);
        break;
      case "ask":
        await handleAsk(cmd);
        break;
      case "status":
        await handleStatus(cmd);
        break;
      default:
        await cmd.reply({ content: "Unknown command", ephemeral: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      if (cmd.deferred || cmd.replied) {
        await cmd.editReply(`Error: ${msg}`);
      } else {
        await cmd.reply({ content: `Error: ${msg}`, ephemeral: true });
      }
    } catch {
      // interaction may have expired
    }
  }
});

// Mention handler -- respond when someone @mentions the bot
// and includes an agent name
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user!)) return;

  const content = message.content
    .replace(/<@!?\d+>/g, "")
    .trim();

  if (!content) {
    await message.reply("Mention me with an agent name and a question. E.g.: `@DEX sentinel how are you?`");
    return;
  }

  // Try to extract agent name from the first word
  const AGENT_NAMES = [
    "sentinel", "protector", "treasurer",
    "dreamer", "coder", "scribe", "observer",
    "director", "composer", "photoblogger",
    "vitals",
  ];

  const words = content.toLowerCase().split(/\s+/);
  const agentName = words.find((w) => AGENT_NAMES.includes(w));

  if (!agentName) {
    await message.reply(
      `Which agent? Available: ${AGENT_NAMES.join(", ")}`,
    );
    return;
  }

  const question = content
    .replace(new RegExp(`\\b${agentName}\\b`, "i"), "")
    .trim();

  if (!question) {
    await message.reply(`What do you want to ask ${agentName}?`);
    return;
  }

  // Fetch agent profile
  let profile: AgentProfile | null = null;
  try {
    const res = await fetch(`${COSMANIA_URL}/dex/agents/${agentName}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      profile = await res.json() as AgentProfile;
    }
  } catch {
    // Fall through to fallback
  }

  if (!profile) {
    // Minimal fallback profile
    profile = {
      name: agentName,
      role: agentName,
      tagline: "",
      type: "creative",
      state: "healthy",
      bubble: "",
      schedule: "",
      executionTier: "none",
      lastRun: null,
    };
  }

  try {
    const result = await chatWithAgent(agentName, question, profile);
    // Post response as the agent via webhook
    await postAsAgent(agentName, result.response, channels);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message.reply(`${agentName} couldn't respond: ${msg}`);
  }
});

// ----- Agent Update Polling -----

let lastRunTimes: Record<string, string> = {};

/**
 * Poll Cosmania for new agent runs and post summaries.
 * Checks every 60s for agents that have completed new runs.
 */
function startAgentPolling(): void {
  setInterval(async () => {
    try {
      const res = await fetch(`${COSMANIA_URL}/dex/agents`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;

      const agents = await res.json() as AgentProfile[];

      for (const agent of agents) {
        if (!agent.lastRun) continue;

        const prev = lastRunTimes[agent.name];
        if (prev && prev === agent.lastRun) continue;

        // New run detected
        lastRunTimes[agent.name] = agent.lastRun;

        // Don't post on first poll (initial state load)
        if (!prev) continue;

        // Post the agent's current bubble as a run summary
        if (agent.bubble) {
          await postAsAgent(agent.name, agent.bubble, channels);
        }
      }
    } catch {
      // Silently skip -- Cosmania may be down
    }
  }, 60_000);
}

// ----- Boot -----

console.log("[discord] Starting COSMANIA DEX bot...");
client.login(DISCORD_TOKEN);
