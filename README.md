# OpenClaw Fleet Config

Repositorio publico de configuracion declarativa para una flota de agentes
[OpenClaw](https://github.com/openclaw/openclaw) desplegados en Coolify.

> **Status:** alpha. Una sola imagen Docker corre cualquier agente declarado
> en `agents/<id>.yaml`. Los secretos viven en Coolify; este repo solo
> contiene placeholders `${VAR_NAME}`.

## Estructura

```
.
├── Dockerfile                       # extiende ghcr.io/openclaw/openclaw:latest + ffmpeg/tesseract/poppler/Python venv
├── entrypoint.sh                    # clone + compile + launch (gateway --bind=lan)
├── docker-compose.coolify.yml       # template para Coolify (1 stack por agente)
├── scripts/
│   ├── compile.py                   # YAML merge + ${VAR} expansion → openclaw.json
│   └── healthcheck.sh
├── profiles/
│   └── base.yaml                    # defaults heredados por todos los agentes
├── agents/
│   ├── _example.yaml                # template — copia, renombra, edita
│   └── <id>.yaml                    # un archivo por agente real
├── skills/                          # skills privadas (procedurales, deterministas)
│   ├── audio-transcribe/SKILL.md
│   ├── tts-emit/SKILL.md
│   ├── image-preprocess/SKILL.md
│   ├── pdf-read-with-ocr-fallback/SKILL.md
│   ├── file-deliver/SKILL.md
│   ├── web-fetch/SKILL.md
│   ├── image-generate/SKILL.md
│   └── presentations/SKILL.md
└── hooks/                           # hooks .ts (PreToolUse/PostToolUse/SessionStart)
    ├── secret-redaction.ts
    ├── path-scrubber.ts
    ├── sensitive-image-gate.ts
    ├── confirm-high-impact.ts
    ├── rate-limit.ts
    ├── structured-logger.ts
    └── crash-recovery.ts
```

## Crear un agente nuevo

```bash
cp agents/_example.yaml agents/alice.yaml
$EDITOR agents/alice.yaml          # rellenar TODO
git add agents/alice.yaml && git commit -m "fleet: add alice"
git push
```

En Coolify:
1. **Add Resource → Docker Compose**, apuntando a este repo + `docker-compose.coolify.yml`.
   Coolify buildea la imagen desde el `Dockerfile` del repo (no necesitas GHCR propio
   — el FROM extiende `ghcr.io/openclaw/openclaw:latest` que ya existe).
2. Env vars del recurso (per-agent):
   - `AGENT_ID=alice`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   (El upper-case se computa solo en `entrypoint.sh`; no setees `AGENT_ID_UPPER`.)
3. Env vars compartidas (proyecto): `OPENAI_API_KEY`, `GEMINI_API_KEY`,
   `FIRECRAWL_API_KEY`, `MINIMAX_API_KEY`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`.
4. Deploy. El `entrypoint.sh` clona el repo, compila la config y arranca el
   gateway en puerto **18789** (`/healthz` para healthcheck).

## Pipeline de cambios

```
edit agents/<id>.yaml → git push → Coolify webhook → redeploy → ~30s vivo
```

Para cambios solo de config caliente (modelo, voz, budget) se puede usar
hot-reload sin downtime via SIGHUP — pendiente de implementar en el harness.

## Secrets

| Variable | Scope | Donde |
|---|---|---|
| `OPENAI_API_KEY` | proyecto | Coolify project env |
| `GEMINI_API_KEY` | proyecto | Coolify project env |
| `FIRECRAWL_API_KEY` | proyecto | Coolify project env |
| `MINIMAX_API_KEY` | proyecto | Coolify project env |
| `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | proyecto | Coolify project env |
| `TELEGRAM_BOT_TOKEN` | per-agent | Coolify resource env (entrypoint lo renombra a `TELEGRAM_BOT_TOKEN_<UPPER(AGENT_ID)>`) |
| `TELEGRAM_CHAT_ID` | per-agent | Coolify resource env (idem) |

**Nunca** commitees valores reales. Solo `${VAR_NAME}` en los YAML.

## Hooks: estado de wiring

Los `.ts` de `hooks/` son scripts standalone (PreToolUse/PostToolUse/SessionStart)
listos para ejecutar pero **el harness de OpenClaw todavia no los invoca**
automaticamente — se monta en `/opt/hooks/` y se referencian en
`fleet-policies.json` para que un futuro `extensions/fleet-hooks/` los registre.

Si quieres engancharlos hoy:
1. Crea un plugin OpenClaw en `extensions/fleet-hooks/` que lea
   `fleet-policies.json` al boot y registre cada `.ts` con el evento
   correspondiente.
2. O ejecutalos manualmente desde una skill que los invoque por shell.

Esto es una decision abierta del fleet-mvp.md — pendiente de cerrar.

## Validacion local

```bash
pip install pyyaml
python3 scripts/compile.py \
  --base profiles/base.yaml \
  --agent agents/alice.yaml \
  --out-dir /tmp/test-compile
ls /tmp/test-compile/
# openclaw.json  fleet-policies.json  prompt.md
```

## Licencia

MIT. Ver `LICENSE`.
