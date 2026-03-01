/**
 * W&B Weave Integration -- Trace all AI calls.
 *
 * Wraps Mistral chat, standup, and bubble compression with weave.op()
 * so every call shows up in the W&B Weave dashboard with inputs,
 * outputs, latency, and token usage.
 *
 * Env: WANDB_API_KEY (required for tracing to land in W&B)
 *
 * If WANDB_API_KEY is not set or the key is invalid (403),
 * all ops behave as plain functions (zero overhead).
 */

import * as weave from "weave";

const PROJECT = "cosmania-dex";

let initialized = false;

/**
 * Initialize Weave tracing. Call once at server boot.
 * No-op if WANDB_API_KEY is not set.
 * Probes the Weave API to verify the key works before activating.
 */
export async function initWeave(): Promise<boolean> {
  if (!process.env.WANDB_API_KEY) {
    console.log("[weave] WANDB_API_KEY not set -- tracing disabled");
    return false;
  }

  // Probe the Weave write endpoint before initializing.
  // The key may authenticate (server_info 200) but lack write permissions
  // (obj/create 403). A 403 on span writes crashes Bun because Weave's
  // internal promise rejection bypasses our handlers.
  try {
    const probe = await fetch("https://trace.wandb.ai/obj/create", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${process.env.WANDB_API_KEY}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ obj: { project_id: PROJECT, object_id: "_probe", val: {} } }),
    });
    if (probe.status === 403 || probe.status === 401) {
      console.warn(`[weave] Write access denied (${probe.status}) -- tracing disabled`);
      return false;
    }
    // Any other non-success is fine (400/422 = bad payload but auth works)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[weave] Cannot reach trace.wandb.ai: ${msg} -- tracing disabled`);
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
  if (!initialized) return fn;
  return weave.op(fn) as T;
}

/**
 * Create a one-shot traced op with a dynamic name.
 * Returns the original function if Weave is not initialized.
 */
export function tracedAs<T extends (...args: any[]) => any>(name: string, fn: T): T {
  if (!initialized) return fn;
  return weave.op(fn, { name }) as T;
}

export { initialized as weaveEnabled };

/**
 * Safety net: catch unhandled rejections from Weave's internal span logging.
 * Even with the probe above, keep this as a backstop.
 */
process.on("unhandledRejection", (reason: unknown) => {
  if (reason && typeof reason === "object" && "url" in reason) {
    const url = String((reason as any).url ?? "");
    if (url.includes("wandb") || url.includes("weave")) {
      console.warn(`[weave] Background trace failed (non-fatal): ${url}`);
      return;
    }
  }
  if (reason instanceof Error) {
    const text = `${reason.message} ${reason.stack ?? ""}`;
    if (text.includes("wandb") || text.includes("weave") || text.includes("trace.wandb")) {
      console.warn(`[weave] Background trace failed (non-fatal): ${reason.message}`);
      return;
    }
  }
  console.error("[unhandledRejection]", reason);
});
