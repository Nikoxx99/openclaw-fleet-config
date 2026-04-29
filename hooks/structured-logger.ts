#!/usr/bin/env -S npx tsx
/**
 * structured-logger
 *
 * Hook: PostToolUse (y PostMessageOut, PostMessageIn)
 *
 * Emite UNA linea JSONL a stdout por cada evento. Coolify/host la recoge.
 * Tambien acumula metricas de coste en `/tmp/agente-<id>/cost-log.jsonl`
 * (append-only) — solo logging, NO enforcement de presupuesto.
 *
 * Schema:
 *   {ts, level, event, agent_id, user_id, thread_id, tool,
 *    duration_ms, status, error_code?, cost_usd?}
 *
 * Reads:  JSON event with timing/result info
 * Writes: nothing to stdout that the harness consumes (log goes to stderr+file)
 *         to stdout writes only the decision { decision: "allow" } so the
 *         hook chain proceeds.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Event = {
  hook: "PostToolUse" | "PostMessageOut" | "PostMessageIn";
  agent_id: string;
  user_id?: string;
  thread_id?: string;
  tool?: string;
  duration_ms?: number;
  status: "ok" | "error" | "timeout";
  error_code?: string;
  cost_usd?: number;
  // detail: provider/model/tokens for cost reconstruction
  detail?: Record<string, unknown>;
};

const LEVEL_FOR_STATUS: Record<Event["status"], "INFO" | "ERROR" | "WARN"> = {
  ok: "INFO",
  error: "ERROR",
  timeout: "WARN",
};

function costLogPath(agentId: string): string {
  return `/tmp/agente-${agentId}/cost-log.jsonl`;
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);

  const ts = new Date().toISOString();
  const level = LEVEL_FOR_STATUS[ev.status];
  const line = {
    ts,
    level,
    event: ev.hook,
    agent_id: ev.agent_id,
    user_id: ev.user_id ?? null,
    thread_id: ev.thread_id ?? null,
    tool: ev.tool ?? null,
    duration_ms: ev.duration_ms ?? null,
    status: ev.status,
    error_code: ev.error_code ?? null,
    cost_usd: ev.cost_usd ?? null,
  };

  // Linea estructurada principal a stderr (Coolify la recoge igual).
  process.stderr.write(JSON.stringify(line) + "\n");

  // Si hay coste, append a cost-log.jsonl (solo registro).
  if (typeof ev.cost_usd === "number" && ev.cost_usd > 0) {
    const costEntry = {
      ts,
      agent_id: ev.agent_id,
      user_id: ev.user_id ?? null,
      tool: ev.tool ?? null,
      cost_usd: ev.cost_usd,
      detail: ev.detail ?? null,
    };
    const path = costLogPath(ev.agent_id);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(costEntry) + "\n", "utf8");
    } catch (e) {
      process.stderr.write(`structured-logger cost append failed: ${(e as Error).message}\n`);
    }
  }

  // PostHook chain continua siempre.
  process.stdout.write(JSON.stringify({ decision: "allow" }));
}

main().catch((e) => {
  process.stderr.write(`structured-logger error: ${(e as Error).message}\n`);
  process.stdout.write(JSON.stringify({ decision: "allow", reason: "logger_error" }));
});
