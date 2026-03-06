/**
 * ElevenLabs Voice Synthesis -- Each agent speaks with a distinct voice.
 *
 * Uses premade ElevenLabs voices mapped to agent personality.
 * Custom cloned voices can override via VOICE_MAP env or agents.toml.
 *
 * Traced via W&B Weave.
 */

import { traced } from "./weave.ts";

// ----- Voice Registry -----

/**
 * Default voice mapping: agent name -> ElevenLabs voice_id.
 * Uses premade voices that match each agent's personality.
 * Override any voice with VOICE_ID_{AGENT} env var.
 */
const DEFAULT_VOICES: Record<string, { id: string; name: string }> = {
  sentinel:     { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel" },       // British, deep, authoritative
  protector:    { id: "2EiwWnXFnvU5JabPnv8n", name: "Clyde" },        // war veteran, gravel
  treasurer:    { id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },         // deep, authoritative
  dreamer:      { id: "LcfcDJNUP1GQjkzn1xUU", name: "Emily" },       // calm, meditation
  coder:        { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },        // deep, youthful
  scribe:       { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },      // calm, narration
  observer:     { id: "piTKgcLEGmPE4e6mEKli", name: "Nicole" },      // whisper
  director:     { id: "nPczCjzI2devNBz1zQrb", name: "Brian" },       // deep, versatile
  composer:     { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda" },     // warm, audiobook
  photoblogger: { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice" },      // British, confident
  vitals:       { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },      // soft, gentle

};

/**
 * Resolve voice ID for an agent.
 * Priority: VOICE_ID_{AGENT} env > DEFAULT_VOICES > null
 */
export function getVoiceId(agentName: string): string | null {
  const envKey = `VOICE_ID_${agentName.toUpperCase()}`;
  const envValue = process.env[envKey];
  if (envValue) return envValue;

  const defaultVoice = DEFAULT_VOICES[agentName];
  return defaultVoice?.id ?? null;
}

// ----- Voice Settings Per Agent Type -----

interface VoiceSettings {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}

const TYPE_VOICE_SETTINGS: Record<string, VoiceSettings> = {
  infrastructure: { stability: 0.7, similarityBoost: 0.8, style: 0.0, speed: 1.0 },
  creative:       { stability: 0.4, similarityBoost: 0.7, style: 0.3, speed: 0.95 },
  production:     { stability: 0.6, similarityBoost: 0.75, style: 0.2, speed: 1.0 },
  embodied:       { stability: 0.3, similarityBoost: 0.8, style: 0.5, speed: 0.85 },
};

function getVoiceSettings(agentType: string): VoiceSettings {
  return TYPE_VOICE_SETTINGS[agentType] ?? TYPE_VOICE_SETTINGS.infrastructure;
}

// ----- Public API -----

export interface SpeechResult {
  audio: ArrayBuffer;
  voiceId: string;
  voiceName: string;
  contentType: string;
  characterCount: number;
}

/**
 * Generate speech for an agent. Returns raw audio buffer.
 * Uses the flash model for low latency.
 *
 * Traced via W&B Weave.
 */
export const generateSpeech = traced(async function generateSpeech(
  agentName: string,
  text: string,
  agentType = "infrastructure",
): Promise<SpeechResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY not set");
  }

  const voiceId = getVoiceId(agentName);
  if (!voiceId) {
    throw new Error(`No voice configured for agent: ${agentName}`);
  }

  const voiceName = DEFAULT_VOICES[agentName]?.name ?? "unknown";
  const settings = getVoiceSettings(agentType);
  const model = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: settings.stability,
          similarity_boost: settings.similarityBoost,
          style: settings.style,
          speed: settings.speed,
        },
      }),
      signal: AbortSignal.timeout(30000),
    },
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs API ${res.status}: ${errBody}`);
  }

  const audio = await res.arrayBuffer();

  return {
    audio,
    voiceId,
    voiceName,
    contentType: "audio/mpeg",
    characterCount: text.length,
  };
});

/**
 * Check if voice synthesis is available.
 */
export function voiceEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

/**
 * List available voices (for debugging).
 */
export async function listVoices(): Promise<Array<{ id: string; name: string; agent: string }>> {
  return Object.entries(DEFAULT_VOICES).map(([agent, voice]) => ({
    id: voice.id,
    name: voice.name,
    agent,
  }));
}
