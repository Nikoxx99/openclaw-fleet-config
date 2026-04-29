#!/usr/bin/env -S npx tsx
/**
 * confirm-high-impact
 *
 * Hook: PreToolUse
 *
 * Bloquea acciones de alto impacto hasta confirmacion explicita del usuario.
 * Lista de tools/actions controladas viene de `policies.confirmation_required`
 * en la config del agente. El payload del hook trae la lista resuelta.
 *
 * Si el usuario ya confirmo en el turno actual (`override_confirmed: true`),
 * pasa. Si no, bloquea con un prompt cerrado "si/no".
 *
 * Reads:  JSON event on stdin
 * Writes: { decision: "block" | "allow", prompt_user?: string }
 */

type Event = {
  hook: "PreToolUse";
  tool: string;                  // ej. "email.send", "fs.delete", "telegram.send"
  payload: Record<string, unknown>;
  agent_id: string;
  confirmation_required: string[];
  override_confirmed?: boolean;
};

const FS_TMP_PREFIXES = ["/tmp/", "/var/tmp/"];

function isFsDeleteOutsideTmp(tool: string, payload: Record<string, unknown>): boolean {
  if (tool !== "fs.delete") return false;
  const target = typeof payload.path === "string" ? payload.path : "";
  return target !== "" && !FS_TMP_PREFIXES.some((p) => target.startsWith(p));
}

function isThirdPartyMessaging(tool: string, payload: Record<string, unknown>, ownerEmail?: string): boolean {
  // tool family: <channel>.send.third_party — el llamador ya marco third_party
  if (/^(slack|whatsapp|telegram)\.send\.third_party$/.test(tool)) return true;
  // email.send con destinatario distinto al owner
  if (tool === "email.send") {
    const to = typeof payload.to === "string" ? payload.to.toLowerCase() : "";
    if (!ownerEmail) return true;
    return to !== ownerEmail.toLowerCase();
  }
  return false;
}

function buildSummary(tool: string, payload: Record<string, unknown>): string {
  const safe = (k: string) => {
    const v = payload[k];
    return typeof v === "string" ? v : JSON.stringify(v ?? null);
  };
  switch (tool) {
    case "email.send":
      return `enviar email a ${safe("to")} con asunto "${safe("subject") || "(sin asunto)"}"`;
    case "fs.delete":
      return `eliminar ${safe("path")}`;
    case "payment.any":
      return `cobrar ${safe("amount")} ${safe("currency") || ""} a ${safe("recipient")}`;
    case "calendar.delete":
      return `eliminar evento ${safe("event_id")}`;
    case "social.publish":
      return `publicar en ${safe("platform")}: "${safe("text")}"`;
    case "integration.rotate_keys":
      return `rotar API keys de ${safe("integration")}`;
    default:
      if (/^(slack|whatsapp|telegram)\.send/.test(tool)) {
        return `enviar mensaje por ${tool.split(".")[0]} a ${safe("to")}: "${safe("text")}"`;
      }
      return `ejecutar ${tool}`;
  }
}

function consequenceLine(tool: string): string {
  if (tool.startsWith("payment")) return "esto mueve dinero real y no se puede deshacer";
  if (tool === "fs.delete") return "el archivo se borra permanentemente";
  if (tool === "social.publish") return "el post queda publico";
  if (tool === "integration.rotate_keys") return "las keys actuales quedan invalidadas";
  if (tool === "calendar.delete") return "el evento se borra permanentemente";
  if (/\.send/.test(tool)) return "el mensaje se envia a un tercero en tu nombre";
  return "esta accion tiene consecuencias visibles";
}

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const ev: Event = JSON.parse(raw);
  const ownerEmail = (ev.payload as { _agent_owner_email?: string })._agent_owner_email;

  // Mapear tool a categoria gate
  const required = new Set(ev.confirmation_required);
  let triggered = false;

  if (required.has(ev.tool)) triggered = true;
  if (required.has("fs.delete_outside_tmp") && isFsDeleteOutsideTmp(ev.tool, ev.payload)) triggered = true;
  if (
    (required.has("email.send") || required.has("slack.dm.third_party") ||
     required.has("whatsapp.send.third_party") || required.has("telegram.send.third_party")) &&
    isThirdPartyMessaging(ev.tool, ev.payload, ownerEmail)
  ) {
    triggered = true;
  }

  if (!triggered) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  if (ev.override_confirmed) {
    process.stdout.write(JSON.stringify({ decision: "allow", reason: "override_confirmed" }));
    return;
  }

  const summary = buildSummary(ev.tool, ev.payload);
  const consequence = consequenceLine(ev.tool);
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `confirmation_required:${ev.tool}`,
      prompt_user: `Voy a ${summary}. Esto: ${consequence}. Confirmas? (si/no)`,
    }),
  );
}

main().catch((e) => {
  process.stderr.write(`confirm-high-impact error: ${(e as Error).message}\n`);
  // fail-closed para alto impacto: si el hook falla, bloquear y pedir confirmacion.
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: "gate_internal_error",
      prompt_user: "No pude verificar si esta accion requiere confirmacion. Confirmas que la ejecute? (si/no)",
    }),
  );
});
