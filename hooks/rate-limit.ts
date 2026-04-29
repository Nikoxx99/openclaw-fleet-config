#!/usr/bin/env -S npx tsx
/**
 * rate-limit
 *
 * Hook: PreToolUse
 *
 * Limita rate por tool y por usuario, persistiendo el contador en disco
 * (`/tmp/agente-<id>/rate-limit.json`) para que sobreviva entre invocaciones
 * del proceso. Limites duros desde `policies.rate_limits` del agente:
 *
 *   - image_gen_per_user_s     (default 10) → 1 image-gen / 10s por user
 *   - llm_per_user_min         (default 20) → 20 llm requests / 60s por user
 *   - burst_collapse_window_s  (default 4)  → si llegan >=2 mensajes en 4s,
 *                                              colapsar (delay este request)
 *
 * Reads:  JSON event with `tool`, `user_id`, `limits` on stdin
 * Writes: { decision: "allow" | "delay" | "block", wait_ms?: number, reason?: string }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

type Event = {
  hook: "PreToolUse";
  tool: string;
  user_id: string;
  agent_id: string;
  limits: {
    image_gen_per_user_s: number;
    llm_per_user_min: number;
    burst_collapse_window_s: number;
  };
};

type State = {
  // key: `${user_id}:${bucket}`, value: array of timestamps (ms)
  buckets: Record<string, number[]>;
};

const TOOLS_IMAGE_GEN = new Set(["image-generate", "image.generate"]);
const TOOLS_LLM = new Set(["llm.chat", "llm.complete"]);
const TOOLS_INBOUND = new Set(["message.received"]); // para burst-collapse

function statePath(agentId: string): string {
  return `/tmp/agente-${agentId}/rate-limit.json`;
}

function loadState(path: string): State {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {
    return { buckets: {} };
  }
}

function saveState(path: string, state: State): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state), "utf8");
}

function pruneBucket(timestamps: number[], windowMs: number, now: number): number[] {
  return timestamps.filter((t) => now - t < windowMs);
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);
  const now = Date.now();
  const sp = statePath(ev.agent_id);
  const state = loadState(sp);

  let bucketName: string | null = null;
  let windowMs = 0;
  let maxInWindow = Infinity;
  let onLimit: "delay" | "block" = "block";
  let waitMsOnLimit: number | undefined;

  if (TOOLS_IMAGE_GEN.has(ev.tool)) {
    bucketName = "image_gen";
    windowMs = ev.limits.image_gen_per_user_s * 1000;
    maxInWindow = 1;
    onLimit = "delay";
    // wait = ventana - tiempo desde el ultimo
  } else if (TOOLS_LLM.has(ev.tool)) {
    bucketName = "llm";
    windowMs = ev.limits.llm_per_user_min * 60 * 1000;
    maxInWindow = ev.limits.llm_per_user_min;
    onLimit = "block";
  } else if (TOOLS_INBOUND.has(ev.tool)) {
    bucketName = "inbound";
    windowMs = ev.limits.burst_collapse_window_s * 1000;
    maxInWindow = 1;
    onLimit = "delay";
    waitMsOnLimit = ev.limits.burst_collapse_window_s * 1000;
  } else {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const key = `${ev.user_id}:${bucketName}`;
  const pruned = pruneBucket(state.buckets[key] ?? [], windowMs, now);

  if (pruned.length >= maxInWindow) {
    if (onLimit === "delay") {
      const lastTs = pruned[pruned.length - 1] ?? now;
      const wait = waitMsOnLimit ?? Math.max(0, windowMs - (now - lastTs));
      // No grabamos timestamp aun; el llamador reintentara tras `wait`.
      process.stdout.write(
        JSON.stringify({
          decision: "delay",
          wait_ms: wait,
          reason: `rate_limit:${bucketName}`,
        }),
      );
      saveState(sp, { ...state, buckets: { ...state.buckets, [key]: pruned } });
      return;
    }
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: `rate_limit_exceeded:${bucketName}`,
      }),
    );
    saveState(sp, { ...state, buckets: { ...state.buckets, [key]: pruned } });
    return;
  }

  pruned.push(now);
  state.buckets[key] = pruned;
  saveState(sp, state);
  process.stdout.write(JSON.stringify({ decision: "allow" }));
}

main().catch((e) => {
  process.stderr.write(`rate-limit error: ${(e as Error).message}\n`);
  // fail-open: nunca bloquear por error del rate limiter.
  process.stdout.write(JSON.stringify({ decision: "allow", reason: "limiter_error" }));
});
