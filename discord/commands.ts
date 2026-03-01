/**
 * Discord Slash Commands
 *
 * /standup  -- trigger a multi-agent group conversation
 * /ask      -- ask a specific agent a question
 * /status   -- show system status overview
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
  EmbedBuilder,
} from "discord.js";
import { chatWithAgent, generateStandup, type AgentProfile } from "../server/mistral.ts";
import { postToStandup } from "./channels.ts";

const COSMANIA_URL = process.env.COSMANIA_URL || "http://localhost:8080";

const AGENT_NAMES = [
  "sentinel", "protector", "treasurer",
  "dreamer", "coder", "scribe", "observer",
  "director", "composer", "photoblogger",
  "vitals", "eros",
];

const TYPE_COLORS: Record<string, number> = {
  infrastructure: 0x7eb8f6,
  creative: 0xbc8cff,
  production: 0x5ec9b3,
  embodied: 0xf0a0b0,
};

// ----- Command Definitions -----

export const commands = [
  new SlashCommandBuilder()
    .setName("standup")
    .setDescription("Trigger a group standup -- all agents report status")
    .addIntegerOption((opt) =>
      opt
        .setName("agents")
        .setDescription("How many agents participate (default: all)")
        .setMinValue(2)
        .setMaxValue(12)
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask a specific agent a question")
    .addStringOption((opt) =>
      opt
        .setName("agent")
        .setDescription("Which agent to talk to")
        .setRequired(true)
        .addChoices(...AGENT_NAMES.map((n) => ({ name: n, value: n }))),
    )
    .addStringOption((opt) =>
      opt
        .setName("question")
        .setDescription("Your question")
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show system status overview"),
];

// ----- Helpers -----

async function fetchRoster(): Promise<AgentProfile[]> {
  try {
    const res = await fetch(`${COSMANIA_URL}/dex/agents`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return await res.json() as AgentProfile[];
  } catch {
    return [];
  }
}

async function fetchProfile(name: string): Promise<AgentProfile | null> {
  try {
    const res = await fetch(`${COSMANIA_URL}/dex/agents/${name}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as AgentProfile;
  } catch {
    return null;
  }
}

// ----- Command Handlers -----

export async function handleStandup(
  interaction: ChatInputCommandInteraction,
  channels: Map<string, TextChannel>,
): Promise<void> {
  const maxAgents = interaction.options.getInteger("agents") ?? 12;

  await interaction.deferReply();

  const profiles = await fetchRoster();
  if (profiles.length === 0) {
    await interaction.editReply("Could not reach Cosmania. Is the health server running?");
    return;
  }

  await interaction.editReply(`Starting standup with ${Math.min(maxAgents, profiles.length)} agents...`);

  try {
    const lines = await generateStandup(profiles, maxAgents);

    // Post each line to #standup as the respective agent
    for (const line of lines) {
      await postToStandup(line.agent, line.message, channels);
      // Brief pause between messages for readability
      await new Promise((r) => setTimeout(r, 800));
    }

    await interaction.editReply(`Standup complete. ${lines.length} agents reported in #standup.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`Standup failed: ${msg}`);
  }
}

export async function handleAsk(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const agentName = interaction.options.getString("agent", true);
  const question = interaction.options.getString("question", true);

  await interaction.deferReply();

  const profile = await fetchProfile(agentName);
  if (!profile) {
    await interaction.editReply(`Could not load profile for ${agentName}. Is Cosmania running?`);
    return;
  }

  try {
    const result = await chatWithAgent(agentName, question, profile);

    const color = TYPE_COLORS[profile.type] ?? 0x7eb8f6;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: agentName.toUpperCase() })
      .setDescription(result.response)
      .setFooter({
        text: `${profile.type} | ${result.model} | ${result.inputTokens + result.outputTokens} tokens`,
      });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`${agentName} couldn't respond: ${msg}`);
  }
}

export async function handleStatus(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply();

  const profiles = await fetchRoster();
  if (profiles.length === 0) {
    await interaction.editReply("Could not reach Cosmania. Is the health server running?");
    return;
  }

  const STATE_ICONS: Record<string, string> = {
    healthy: "\u25CF", // filled circle
    working: "\u25B6", // play triangle
    sick: "\u2716",    // heavy X
    sleeping: "\u25CB", // empty circle
  };

  const lines = profiles.map((p) => {
    const icon = STATE_ICONS[p.state] ?? "\u25CF";
    const lastRun = p.lastRun
      ? timeAgo(p.lastRun)
      : "never";
    return `${icon} **${p.name}** (${p.type}) -- ${lastRun}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x7eb8f6)
    .setTitle("COSMANIA STATUS")
    .setDescription(lines.join("\n"))
    .setFooter({ text: `${profiles.length} agents | ${new Date().toISOString()}` });

  await interaction.editReply({ embeds: [embed] });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
