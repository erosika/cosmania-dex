/**
 * W&B Weave Integration -- Trace all AI calls.
 *
 * Wraps Mistral chat, standup, and bubble compression with weave.op()
 * so every call shows up in the W&B Weave dashboard with inputs,
 * outputs, latency, and token usage.
 *
 * Env: WANDB_API_KEY (required for tracing to land in W&B)
 *
 * If WANDB_API_KEY is not set, weave.init() is never called
 * and all ops behave as plain functions (zero overhead).
 */

import * as weave from "weave";

const PROJECT = "cosmania-dex";

let initialized = false;

/**
 * Initialize Weave tracing. Call once at server boot.
 * No-op if WANDB_API_KEY is not set.
 */
export async function initWeave(): Promise<boolean> {
  if (!process.env.WANDB_API_KEY) {
    console.log("[weave] WANDB_API_KEY not set -- tracing disabled");
    return false;
  }

  try {
    await weave.init(PROJECT);
    initialized = true;
    console.log(`[weave] Tracing enabled -- project: ${PROJECT}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[weave] Failed to initialize: ${msg}`);
    return false;
  }
}

/**
 * Wrap a function with weave.op() for tracing.
 * Returns the original function if Weave is not initialized.
 */
export function traced<T extends (...args: any[]) => any>(fn: T): T {
  return weave.op(fn) as T;
}

export { initialized as weaveEnabled };
