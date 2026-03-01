/**
 * Discord Channel Configuration + Webhook Management
 *
 * Maps agents to channels. Creates webhooks per agent so
 * messages appear to come from distinct agent identities.
 */

import {
  Client,
  TextChannel,
  Webhook,
  type Guild,
} from "discord.js";

// ----- Channel Mapping -----

export interface ChannelConfig {
  name: string;
  topic: string;
  agents: string[];
}

export const CHANNEL_MAP: ChannelConfig[] = [
  {
    name: "ops-room",
    topic: "Infrastructure alerts and health checks",
    agents: ["sentinel", "protector"],
  },
  {
    name: "budget",
    topic: "Spending alerts and budget tier changes",
    agents: ["treasurer"],
  },
  {
    name: "creative",
    topic: "Vault updates, code tasks, observations, reports",
    agents: ["dreamer", "coder", "observer", "scribe"],
  },
  {
    name: "production",
    topic: "Video, music, and photo pipeline updates",
    agents: ["director", "composer", "photoblogger"],
  },
  {
    name: "standup",
    topic: "Scheduled group conversations between all agents",
    agents: [], // All agents post here during standups
  },
  {
    name: "general",
    topic: "Talk to any agent -- mention them by name",
    agents: [], // Any agent responds to mentions
  },
];

/**
 * Get the channel name an agent should post to.
 */
export function getChannelForAgent(agentName: string): string {
  for (const ch of CHANNEL_MAP) {
    if (ch.agents.includes(agentName)) return ch.name;
  }
  return "general";
}

// ----- Webhook Management -----

/** Cache of agent name -> webhook */
const webhookCache = new Map<string, Webhook>();

/**
 * Ensure all channels exist in the guild.
 * Creates missing channels with proper topics.
 */
export async function ensureChannels(guild: Guild): Promise<Map<string, TextChannel>> {
  const channels = new Map<string, TextChannel>();

  for (const config of CHANNEL_MAP) {
    const existing = guild.channels.cache.find(
      (ch) => ch.name === config.name && ch.isTextBased(),
    ) as TextChannel | undefined;

    if (existing) {
      channels.set(config.name, existing);
    } else {
      try {
        const created = await guild.channels.create({
          name: config.name,
          topic: config.topic,
        });
        channels.set(config.name, created as TextChannel);
        console.log(`[discord] Created #${config.name}`);
      } catch (err) {
        console.error(`[discord] Failed to create #${config.name}:`, err);
      }
    }
  }

  return channels;
}

/**
 * Get or create a webhook for an agent in the appropriate channel.
 * The webhook uses the agent's name and (eventually) pixel art avatar.
 */
export async function getAgentWebhook(
  agentName: string,
  channels: Map<string, TextChannel>,
): Promise<Webhook | null> {
  if (webhookCache.has(agentName)) {
    return webhookCache.get(agentName)!;
  }

  const channelName = getChannelForAgent(agentName);
  const channel = channels.get(channelName);
  if (!channel) return null;

  try {
    // Check for existing webhook
    const existing = await channel.fetchWebhooks();
    const found = existing.find((wh) => wh.name === agentName);
    if (found) {
      webhookCache.set(agentName, found);
      return found;
    }

    // Create new webhook
    const webhook = await channel.createWebhook({
      name: agentName,
      reason: `COSMANIA DEX -- ${agentName} agent webhook`,
    });
    webhookCache.set(agentName, webhook);
    console.log(`[discord] Created webhook for ${agentName} in #${channelName}`);
    return webhook;
  } catch (err) {
    console.error(`[discord] Failed to create webhook for ${agentName}:`, err);
    return null;
  }
}

/**
 * Post a message as an agent via its webhook.
 */
export async function postAsAgent(
  agentName: string,
  content: string,
  channels: Map<string, TextChannel>,
): Promise<void> {
  const webhook = await getAgentWebhook(agentName, channels);
  if (!webhook) {
    console.warn(`[discord] No webhook for ${agentName}, falling back to channel post`);
    const channelName = getChannelForAgent(agentName);
    const channel = channels.get(channelName);
    if (channel) {
      await channel.send(`**${agentName}**: ${content}`);
    }
    return;
  }

  await webhook.send({
    content,
    username: agentName.toUpperCase(),
    // avatarURL will be set when we have sprite PNGs hosted
  });
}

/**
 * Post a standup message to the #standup channel.
 */
export async function postToStandup(
  agentName: string,
  content: string,
  channels: Map<string, TextChannel>,
): Promise<void> {
  const channel = channels.get("standup");
  if (!channel) return;

  // Use the standup channel's webhook for the agent
  try {
    const existing = await channel.fetchWebhooks();
    let webhook = existing.find((wh) => wh.name === agentName);
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: agentName,
        reason: `COSMANIA DEX standup -- ${agentName}`,
      });
    }
    await webhook.send({
      content,
      username: agentName.toUpperCase(),
    });
  } catch {
    await channel.send(`**${agentName}**: ${content}`);
  }
}

/** Clear webhook cache (for testing). */
export function _resetWebhookCache(): void {
  webhookCache.clear();
}
