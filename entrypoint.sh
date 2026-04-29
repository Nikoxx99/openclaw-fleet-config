#!/usr/bin/env bash
# entrypoint.sh — clona el repo de fleet, compila la config del agente
# definido en $AGENT_ID, materializa skills/hooks, y arranca el gateway.
#
# Vars esperadas (Coolify):
#   AGENT_ID         ej. "alice" — debe existir agents/${AGENT_ID}.yaml
#   FLEET_REF        branch o tag (default: main)
#   FLEET_REPO_URL   default: https://github.com/Nikoxx99/openclaw-fleet-config.git
#   + todos los ${VAR} referenciados desde el YAML del agente

set -euo pipefail

# AGENT_ID puede venir de:
#   - el primer argumento del comando (compose: command: ["agent01"]) — preferido
#   - o de la env var AGENT_ID (deploy manual / docker run -e AGENT_ID=...)
# El primer arg gana porque en Coolify multi-service las env vars con el mismo
# nombre se deduplican entre services (issue coollabsio/coolify#7655) y todos
# los containers acabarian con el mismo AGENT_ID.
AGENT_ID="${1:-${AGENT_ID:-}}"
: "${AGENT_ID:?AGENT_ID is required (pass as first arg in compose: command: [\"agent01\"])}"
: "${FLEET_REF:=main}"
: "${FLEET_REPO_URL:=https://github.com/Nikoxx99/openclaw-fleet-config.git}"
: "${FLEET_DIR:=/opt/fleet}"
: "${HOOKS_DIR:=/opt/hooks}"
: "${OPENCLAW_HOME:=/home/node/.openclaw}"

log() { printf '{"ts":"%s","level":"INFO","event":"entrypoint","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1"; }
err() { printf '{"ts":"%s","level":"ERROR","event":"entrypoint","msg":"%s"}\n' "$(date -u +%FT%TZ)" "$1" >&2; }

# 0) Re-exportar env vars per-agent con el nombre que el YAML espera.
#    Coolify pasa TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID con nombres fijos
#    (no puede interpolar en YAML keys). El YAML del agente referencia
#    ${TELEGRAM_BOT_TOKEN_AGENT01} — aqui lo creamos.
upper=$(printf '%s' "$AGENT_ID" | tr '[:lower:]-' '[:upper:]_')
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  export "TELEGRAM_BOT_TOKEN_${upper}=${TELEGRAM_BOT_TOKEN}"
fi
if [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  export "TELEGRAM_CHAT_ID_${upper}=${TELEGRAM_CHAT_ID}"
fi

# 1) Clonar / actualizar fleet config.
if [ ! -d "$FLEET_DIR/.git" ]; then
  log "cloning ${FLEET_REPO_URL}@${FLEET_REF}"
  git clone --depth 1 --branch "$FLEET_REF" "$FLEET_REPO_URL" "$FLEET_DIR"
else
  log "fleet dir exists; pulling ${FLEET_REF}"
  git -C "$FLEET_DIR" fetch --depth 1 origin "$FLEET_REF"
  git -C "$FLEET_DIR" checkout -B "$FLEET_REF" "origin/${FLEET_REF}"
fi

# 2) Validar que el agente existe.
AGENT_YAML="$FLEET_DIR/agents/${AGENT_ID}.yaml"
if [ ! -f "$AGENT_YAML" ]; then
  err "agent file not found: agents/${AGENT_ID}.yaml in ref=${FLEET_REF}"
  exit 2
fi

# 3) Compilar YAML → openclaw.json + fleet-policies.json + prompt.md
mkdir -p "$OPENCLAW_HOME"
log "compiling agent ${AGENT_ID}"
python3 "$FLEET_DIR/scripts/compile.py" \
  --base "$FLEET_DIR/profiles/base.yaml" \
  --agent "$AGENT_YAML" \
  --out-dir "$OPENCLAW_HOME"

# 4) Montar skills (symlink) en el dir que el harness escanea.
mkdir -p "$OPENCLAW_HOME/skills"
for skill_dir in "$FLEET_DIR/skills/"*/; do
  [ -d "$skill_dir" ] || continue
  name=$(basename "$skill_dir")
  ln -sfn "$skill_dir" "$OPENCLAW_HOME/skills/$name"
done
log "mounted $(ls "$OPENCLAW_HOME/skills" 2>/dev/null | wc -l) skills"

# 5) Montar hooks (.ts) en /opt/hooks.
for hook in "$FLEET_DIR/hooks/"*.ts; do
  [ -f "$hook" ] || continue
  cp "$hook" "$HOOKS_DIR/"
  chmod +x "$HOOKS_DIR/$(basename "$hook")"
done
log "mounted $(ls "$HOOKS_DIR"/*.ts 2>/dev/null | wc -l) hooks"

# 6) Sandbox dir del agente.
SANDBOX="/tmp/agente-${AGENT_ID}"
mkdir -p "$SANDBOX"/{img,img-gen,tts,decks}
log "sandbox ready at $SANDBOX"

# 7) Arrancar el gateway oficial. Bind=lan para que Coolify lo enrute.
#    `--allow-unconfigured` deja arrancar mientras la onboarding inicial corre.
log "starting openclaw gateway for agent=${AGENT_ID}"
exec node /app/openclaw.mjs gateway --bind=lan --allow-unconfigured
