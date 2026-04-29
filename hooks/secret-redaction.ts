#!/usr/bin/env -S npx tsx
/**
 * secret-redaction
 *
 * Hook: PreToolUse + PostToolUse
 *
 * Filtra patrones de secretos en inputs antes de mandar a un tool externo
 * y en outputs antes de loggear o devolver al usuario. Sustituye por
 * `[REDACTED:<kind>]`. NO bloquea; solo reescribe.
 *
 * Reads:  JSON event on stdin
 * Writes: { decision: "modify", payload: <scrubbed> } on stdout
 * Exit:   0 always (no hard block here; hard blocks belong to confirm-high-impact)
 */

type Event = {
  hook: "PreToolUse" | "PostToolUse";
  tool: string;
  payload: unknown;
  agent_id: string;
  agent_owner_email?: string;
};

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9_\-]{20,}\b/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  { kind: "google_key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { kind: "minimax_key", re: /\bsk-cp-[A-Za-z0-9_\-]{40,}\b/g },
  { kind: "firecrawl_key", re: /\bfc-[a-f0-9]{20,}\b/g },
  { kind: "telegram_bot_token", re: /\b\d{8,12}:[A-Za-z0-9_\-]{30,}\b/g },
  { kind: "bearer_token", re: /\bBearer\s+[A-Za-z0-9_\-\.]{20,}\b/gi },
  { kind: "long_digit_run", re: /(?<!\d)\d{12,}(?!\d)/g }, // posible tarjeta/DNI/tlf largo
  { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
];

function emailRedactor(ownerEmail: string | undefined): { kind: string; re: RegExp; allow: (m: string) => boolean } {
  return {
    kind: "email_third_party",
    re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    allow: (m) => !!ownerEmail && m.toLowerCase() === ownerEmail.toLowerCase(),
  };
}

function scrub(text: string, ownerEmail?: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  const er = emailRedactor(ownerEmail);
  out = out.replace(er.re, (m) => (er.allow(m) ? m : `[REDACTED:${er.kind}]`));
  return out;
}

function deepScrub(value: unknown, ownerEmail?: string): unknown {
  if (typeof value === "string") return scrub(value, ownerEmail);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, ownerEmail));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepScrub(v, ownerEmail);
    }
    return out;
  }
  return value;
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);
  const scrubbed = deepScrub(ev.payload, ev.agent_owner_email);
  process.stdout.write(JSON.stringify({ decision: "modify", payload: scrubbed }));
}

main().catch((e) => {
  process.stderr.write(`secret-redaction error: ${(e as Error).message}\n`);
  process.exit(0); // fail-open: nunca bloquear flujo por error del hook
});
