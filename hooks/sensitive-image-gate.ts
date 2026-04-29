#!/usr/bin/env -S npx tsx
/**
 * sensitive-image-gate
 *
 * Hook: PreToolUse
 *
 * Para tools que analizan imagenes, corre un detector ligero CPU-only y
 * bloquea con confirmacion si detecta:
 *   - documento de identidad
 *   - tarjeta bancaria
 *   - historial medico
 *   - captura de chat de terceros
 *
 * Detector heuristico determinista (no ML):
 *   - OCR rapido con tesseract (timeout 5s)
 *   - keywords match
 *   - aspect ratio (tarjetas ~1.586:1)
 *
 * Reads:  JSON event with `image_path` in payload
 * Writes: { decision: "block" | "allow", reason?: string, prompt_user?: string }
 */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

type Event = {
  hook: "PreToolUse";
  tool: string;
  payload: { image_path?: string; [k: string]: unknown };
  agent_id: string;
  override_confirmed?: boolean;
};

const TOOLS_TO_GATE = new Set(["image-analysis", "multimodal-llm", "image-generate"]);

const KEYWORDS_ID = ["dni", "documento nacional", "pasaporte", "passport", "licencia", "driver license", "id card"];
const KEYWORDS_CARD = ["visa", "mastercard", "credit card", "cvv", "expira"];
const KEYWORDS_MEDICAL = ["historial medico", "diagnostico", "paciente", "rx:", "patient", "medical record"];
const KEYWORDS_CHAT = ["whatsapp", "telegram", "imessage", "ayer 22:", "ayer 21:", "online", "escribiendo..."];

function ocrQuick(path: string, timeoutMs = 5000): string {
  try {
    return execFileSync("tesseract", [path, "-", "-l", "spa+eng", "--psm", "6"], {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .toLowerCase();
  } catch {
    return "";
  }
}

function aspectRatio(path: string): number | null {
  try {
    const out = execFileSync("identify", ["-format", "%w %h", path], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const [w, h] = out.trim().split(/\s+/).map(Number);
    if (!w || !h) return null;
    return w / h;
  } catch {
    return null;
  }
}

function detect(path: string): { hit: boolean; kind?: string } {
  const ar = aspectRatio(path);
  if (ar && Math.abs(ar - 1.586) < 0.05) {
    const text = ocrQuick(path);
    if (KEYWORDS_CARD.some((k) => text.includes(k))) return { hit: true, kind: "credit_card" };
  }
  const text = ocrQuick(path);
  if (KEYWORDS_ID.some((k) => text.includes(k))) return { hit: true, kind: "id_document" };
  if (KEYWORDS_MEDICAL.some((k) => text.includes(k))) return { hit: true, kind: "medical_record" };
  if (KEYWORDS_CHAT.some((k) => text.includes(k))) return { hit: true, kind: "third_party_chat" };
  return { hit: false };
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);

  if (!TOOLS_TO_GATE.has(ev.tool)) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const path = ev.payload.image_path;
  if (typeof path !== "string" || !path) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  try {
    statSync(path);
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow", reason: "image_not_found" }));
    return;
  }

  if (ev.override_confirmed) {
    process.stdout.write(JSON.stringify({ decision: "allow", reason: "override_confirmed" }));
    return;
  }

  const result = detect(path);
  if (result.hit) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: `sensitive_content_detected:${result.kind}`,
        prompt_user: `Detecto informacion sensible en la imagen (${result.kind}). Confirmas que quieres que la procese? (si/no)`,
      }),
    );
    return;
  }

  process.stdout.write(JSON.stringify({ decision: "allow" }));
}

main().catch((e) => {
  process.stderr.write(`sensitive-image-gate error: ${(e as Error).message}\n`);
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: "gate_internal_error",
      prompt_user: "No pude analizar la imagen para verificar contenido sensible. Confirmas que la procese igualmente? (si/no)",
    }),
  );
});
