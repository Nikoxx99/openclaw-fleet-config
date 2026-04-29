#!/usr/bin/env -S npx tsx
/**
 * path-scrubber
 *
 * Hook: PreMessageOut (antes de enviar texto al usuario por cualquier canal)
 *
 * Reescribe rutas internas (`/tmp/agente-<id>/...`, `/data/workspace/...`,
 * paths con hashes) por nombres humanos cuando aparecen en mensajes salientes.
 * Si no se puede humanizar, omite la ruta completa y deja un placeholder
 * `[archivo]`. Esto evita filtrar paths internos al usuario final.
 *
 * Reads:  JSON event on stdin
 * Writes: { decision: "modify", message: <scrubbed> } on stdout
 */

type Event = {
  hook: "PreMessageOut";
  channel: "telegram" | "email" | "slack" | "whatsapp" | string;
  message: string;
  agent_id: string;
};

const PATH_PATTERNS: RegExp[] = [
  /\/tmp\/agente-[a-z0-9_\-]+\/[^\s)\]"',]+/g,
  /\/data\/workspace\/[^\s)\]"',]+/g,
  /\/var\/log\/agente\/[^\s)\]"',]+/g,
  /\/opt\/[^\s)\]"',]+/g,
  /\/home\/[a-z0-9_\-]+\/[^\s)\]"',]+/g,
];

const HASHY_BASENAME = /^[a-f0-9]{12,}\.[a-z0-9]{2,5}$/i;

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function humanize(path: string): string {
  const b = basename(path);
  if (HASHY_BASENAME.test(b)) return "[archivo]";
  // Si tiene extension, devolver solo el basename (limpio).
  if (/\.[a-z0-9]{2,5}$/i.test(b)) return b;
  return "[archivo]";
}

function scrub(message: string): string {
  let out = message;
  for (const re of PATH_PATTERNS) {
    out = out.replace(re, (match) => humanize(match));
  }
  return out;
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);
  const scrubbed = scrub(ev.message);
  process.stdout.write(JSON.stringify({ decision: "modify", message: scrubbed }));
}

main().catch((e) => {
  process.stderr.write(`path-scrubber error: ${(e as Error).message}\n`);
  process.exit(0);
});
