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
 * Resolves the W&B entity and probes write access before activating.
 */
export async function initWeave(): Promise<boolean> {
  if (!process.env.WANDB_API_KEY) {
    console.log("[weave] WANDB_API_KEY not set -- tracing disabled");
    return false;
  }

  const basicAuth = `Basic ${btoa(`api:${process.env.WANDB_API_KEY}`)}`;

  // Resolve entity name (same GraphQL query the SDK uses)
  let entity: string;
  try {
    const gql = await fetch("https://api.wandb.ai/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth },
      body: JSON.stringify({
        query: `query { viewer { defaultEntity { name } } }`,
      }),
    });
    if (!gql.ok) {
      console.warn(`[weave] GraphQL auth failed (${gql.status}) -- tracing disabled`);
      return false;
    }
    const data = await gql.json();
    entity = data?.data?.viewer?.defaultEntity?.name;
    if (!entity) {
      console.warn("[weave] No default entity found -- tracing disabled");
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[weave] Cannot reach api.wandb.ai: ${msg} -- tracing disabled`);
    return false;
  }

  // Probe obj/create with entity/project format (matches SDK)
  try {
    const probe = await fetch("https://trace.wandb.ai/obj/create", {
      method: "POST",
      headers: { Authorization: basicAuth, "Content-Type": "application/json" },
      body: JSON.stringify({
        obj: { project_id: `${entity}/${PROJECT}`, object_id: "_probe", val: {} },
      }),
    });
    if (probe.status === 403 || probe.status === 401) {
      console.warn(`[weave] Write access denied (${probe.status}) -- tracing disabled`);
      return false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[weave] Cannot reach trace.wandb.ai: ${msg} -- tracing disabled`);
    return false;
  }

  try {
    await weave.init(PROJECT);
    initialized = true;
    console.log(`[weave] Tracing enabled -- entity: ${entity}, project: ${PROJECT}`);
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
 * Wraps in try/catch so Weave failures never crash the caller.
 */
export function traced<T extends (...args: any[]) => any>(fn: T): T {
  if (!initialized) return fn;
  const op = weave.op(fn);
  const safe = (async (...args: any[]) => {
    try {
      return await op(...args);
    } catch (e) {
      console.warn(`[weave] Traced op failed, running untraced:`, e instanceof Error ? e.message : e);
      return fn(...args);
    }
  }) as unknown as T;
  return safe;
}

/**
 * Create a one-shot traced op with a dynamic name.
 * Returns the original function if Weave is not initialized.
 * Wraps in try/catch so Weave failures never crash the caller.
 */
export function tracedAs<T extends (...args: any[]) => any>(name: string, fn: T): T {
  if (!initialized) return fn;
  const op = weave.op(fn, { name });
  // Wrap so that if weave.op's internal span machinery throws, we fall back to the raw function
  const safe = (async (...args: any[]) => {
    try {
      return await op(...args);
    } catch (e) {
      console.warn(`[weave] Traced op "${name}" failed, running untraced:`, e instanceof Error ? e.message : e);
      return fn(...args);
    }
  }) as unknown as T;
  return safe;
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
