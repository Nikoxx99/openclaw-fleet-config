#!/usr/bin/env -S npx tsx
/**
 * crash-recovery
 *
 * Hook: SessionStart
 *
 * Al arrancar el agente (post-crash o boot frio), lee la ultima linea del
 * `runtime.crash_recovery.log_path` (default `/var/log/agente/last.jsonl`)
 * y, si encuentra un mensaje de usuario que quedo sin responder ('status:
 * "in_flight"'), inyecta un mensaje al hilo de ese usuario pidiendo
 * disculpas y ofreciendo retomar.
 *
 * NO retoma automaticamente — solo ofrece. La decision queda en manos del
 * usuario para evitar dobles ejecuciones.
 *
 * Reads:  JSON event with `agent_id`, `log_path`
 * Writes: { decision: "allow", side_effects: [{ to_user_id, message }] }
 */

import { readFileSync, statSync } from "node:fs";

type Event = {
  hook: "SessionStart";
  agent_id: string;
  log_path?: string;
};

type LogLine = {
  ts: string;
  event: string;
  user_id?: string;
  thread_id?: string;
  tool?: string;
  status: "ok" | "error" | "timeout" | "in_flight";
};

const DEFAULT_LOG = "/var/log/agente/last.jsonl";

function readLastInFlight(path: string): LogLine | null {
  try {
    statSync(path);
  } catch {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  // Buscar la ultima entrada con status `in_flight` que no tenga un par `ok`/`error`/`timeout` posterior con mismo thread_id.
  const closed = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: LogLine;
    try {
      entry = JSON.parse(lines[i]) as LogLine;
    } catch {
      continue;
    }
    if (!entry.thread_id) continue;
    if (entry.status === "ok" || entry.status === "error" || entry.status === "timeout") {
      closed.add(entry.thread_id);
      continue;
    }
    if (entry.status === "in_flight" && !closed.has(entry.thread_id)) {
      return entry;
    }
  }
  return null;
}

function buildApology(entry: LogLine): string {
  const tool = entry.tool ?? "tu peticion";
  return `Se me reinicio el contenedor mientras procesaba ${tool}. Lo reintento? (si/no)`;
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);
  const path = ev.log_path ?? DEFAULT_LOG;
  const inFlight = readLastInFlight(path);

  if (!inFlight || !inFlight.user_id) {
    process.stdout.write(JSON.stringify({ decision: "allow", side_effects: [] }));
    return;
  }

  process.stdout.write(
    JSON.stringify({
      decision: "allow",
      side_effects: [
        {
          kind: "send_message",
          to_user_id: inFlight.user_id,
          thread_id: inFlight.thread_id,
          message: buildApology(inFlight),
          context: { recovered_from: inFlight.ts, tool: inFlight.tool ?? null },
        },
      ],
    }),
  );
}

main().catch((e) => {
  process.stderr.write(`crash-recovery error: ${(e as Error).message}\n`);
  process.stdout.write(JSON.stringify({ decision: "allow", side_effects: [], reason: "recovery_error" }));
});
