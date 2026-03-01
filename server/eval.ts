/**
 * Weave Evaluation -- Agent Tool Calling Quality
 *
 * Tests that agents:
 *   1. Call tools when asked about system state, health, costs
 *   2. Skip tools for casual/social conversation
 *   3. Call the RIGHT tools for the question
 *
 * Run: COSMANIA_URL=... MISTRAL_API_KEY=... WANDB_API_KEY=... bun run server/eval.ts
 */

import * as weave from "weave";
import { Mistral } from "@mistralai/mistralai";
import { chatWithAgent, type AgentProfile, type ChatResult } from "./mistral.ts";

await weave.init("cosmania-dex");

// ----- Dataset -----

interface EvalRow {
  agent: string;
  message: string;
  expectTools: boolean;
  expectedToolNames: string[];
  category: string;
}

const dataset = new weave.Dataset<EvalRow>({
  id: "agent-tool-calling-v1",
  rows: [
    // sentinel -- infrastructure agent, should use tools for health/status
    {
      agent: "sentinel",
      message: "are any agents having problems right now?",
      expectTools: true,
      expectedToolNames: ["find_unhealthy_agents", "check_system_health"],
      category: "health",
    },
    {
      agent: "sentinel",
      message: "give me a status report on the whole system",
      expectTools: true,
      expectedToolNames: ["check_system_health", "query_roster"],
      category: "health",
    },
    {
      agent: "sentinel",
      message: "how are you doing today?",
      expectTools: false,
      expectedToolNames: [],
      category: "casual",
    },

    // treasurer -- should use cost tools
    {
      agent: "treasurer",
      message: "what's our total spend today?",
      expectTools: true,
      expectedToolNames: ["get_cost_summary"],
      category: "cost",
    },
    {
      agent: "treasurer",
      message: "which agent is the most expensive?",
      expectTools: true,
      expectedToolNames: ["get_cost_summary", "query_roster"],
      category: "cost",
    },
    {
      agent: "treasurer",
      message: "hey treasurer, what's good?",
      expectTools: false,
      expectedToolNames: [],
      category: "casual",
    },

    // dreamer -- knowledge agent, should search memory
    {
      agent: "dreamer",
      message: "what has eri been working on lately?",
      expectTools: true,
      expectedToolNames: ["recall_memory"],
      category: "memory",
    },
    {
      agent: "dreamer",
      message: "tell me about yourself",
      expectTools: false,
      expectedToolNames: [],
      category: "casual",
    },

    // coder -- knowledge agent
    {
      agent: "coder",
      message: "what tools does sentinel have access to?",
      expectTools: true,
      expectedToolNames: ["query_agent_capabilities"],
      category: "capabilities",
    },
    {
      agent: "coder",
      message: "nice weather we're having",
      expectTools: false,
      expectedToolNames: [],
      category: "casual",
    },
  ],
});

// ----- Model Under Test -----

const FALLBACK_PROFILE: AgentProfile = {
  name: "", role: "", tagline: "A Cosmania agent.", type: "infrastructure",
  state: "healthy", bubble: "", schedule: "*/5 * * * *",
  executionTier: "standard", lastRun: new Date().toISOString(),
};

const agentChat = weave.op(
  async function agentChat({ agent, message }: { agent: string; message: string }): Promise<ChatResult> {
    const profile: AgentProfile = { ...FALLBACK_PROFILE, name: agent, role: agent };
    return chatWithAgent(agent, message, profile, []);
  },
  { name: "agentChat", opKind: "agent" },
);

// ----- Scorers -----

const toolUsageCorrect = weave.op(
  function toolUsageCorrect({ datasetRow, modelOutput }: { datasetRow: EvalRow; modelOutput: ChatResult }) {
    const usedTools = (modelOutput.toolCalls?.length ?? 0) > 0;
    return usedTools === datasetRow.expectTools;
  },
  { name: "tool_usage_correct" },
);

const correctToolCalled = weave.op(
  function correctToolCalled({ datasetRow, modelOutput }: { datasetRow: EvalRow; modelOutput: ChatResult }) {
    if (!datasetRow.expectTools) return true; // n/a for casual
    if (!modelOutput.toolCalls || modelOutput.toolCalls.length === 0) return false;

    const calledNames = new Set(modelOutput.toolCalls.map((tc) => tc.name));
    // At least one expected tool was called
    return datasetRow.expectedToolNames.some((name) => calledNames.has(name));
  },
  { name: "correct_tool_called" },
);

const responseNotEmpty = weave.op(
  function responseNotEmpty({ modelOutput }: { datasetRow: EvalRow; modelOutput: ChatResult }) {
    return modelOutput.response.length > 0 && !modelOutput.response.startsWith("[");
  },
  { name: "response_not_empty" },
);

const toolsAllSucceeded = weave.op(
  function toolsAllSucceeded({ modelOutput }: { datasetRow: EvalRow; modelOutput: ChatResult }) {
    if (!modelOutput.toolCalls || modelOutput.toolCalls.length === 0) return true;
    return modelOutput.toolCalls.every((tc) => tc.result.success);
  },
  { name: "tools_all_succeeded" },
);

// ----- Run Evaluation -----

const evaluation = new weave.Evaluation({
  id: "agent-tool-calling-eval-v1",
  dataset,
  scorers: [toolUsageCorrect, correctToolCalled, responseNotEmpty, toolsAllSucceeded],
});

console.log("[eval] Starting agent tool calling evaluation...");
console.log("[eval] Dataset: 10 test cases across 4 agents");
console.log("[eval] Scorers: tool_usage_correct, correct_tool_called, response_not_empty, tools_all_succeeded\n");

const results = await evaluation.evaluate({ model: agentChat });

console.log("\n[eval] Evaluation complete.");
console.log("[eval] Results:", JSON.stringify(results, null, 2));
