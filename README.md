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

## Modelo de despliegue

El compose incluye **4 services pre-declarados** (`agent01`..`agent04`),
pensados para un taller con 4 participantes. Coolify los deploya **en un
solo Resource** y muestra cada uno como un service separado en la UI.

### Crear el Resource (1 sola vez)

1. Coolify → **+ New Application** → **Public Repository**.
2. URL: `https://github.com/Nikoxx99/openclaw-fleet-config`. Branch: `main`.
3. **Build Pack: Docker Compose**.
4. Compose file location: `/docker-compose.coolify.yml`.
5. Save → Coolify auto-detecta los `${VAR_AGENT0N}` y los muestra vacios.

### Setear env vars

**Globales** (Project env, una sola vez):

```
MINIMAX_API_KEY=...
FIRECRAWL_API_KEY=...
ELEVENLABS_API_KEY=...
R2_BUCKET=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

**Per-agent** (Resource env, 4 sets, sufijo `_AGENT01..04`):

```
OPENAI_API_KEY_AGENT01=<la del participante 1>
GEMINI_API_KEY_AGENT01=<idem>
TELEGRAM_BOT_TOKEN_AGENT01=<bot del participante 1>
TELEGRAM_CHAT_ID_AGENT01=<chat del participante 1>

OPENAI_API_KEY_AGENT02=<la del participante 2>
... (idem para 02, 03, 04)
```

6. Deploy. Coolify buildea **una sola vez** (mismo Dockerfile para los 4) y
   arranca los 4 containers. Cada uno corre el `entrypoint.sh` con su
   `AGENT_ID` propio (hardcoded en el compose), clona el repo, compila su
   config y arranca el gateway de OpenClaw en puerto 18789 interno.

### Asignar a un participante

Cuando le asignes un slot a alguien:

```bash
$EDITOR agents/agent01.yaml
# - identity.name → nombre del participante
# - identity.owner → email del participante
# - judgment_rules → memoria/personalidad inicial si quieres custom
git commit -am "fleet: assign agent01 to <participant>" && git push
```

Coolify recibe el webhook y redeploya solo el service afectado en ~30s.

## Pipeline de cambios

```
edit agents/<id>.yaml → git push → Coolify webhook → redeploy → ~30s vivo
```

Para cambios solo de config caliente (modelo, voz, budget) se puede usar
hot-reload sin downtime via SIGHUP — pendiente de implementar en el harness.

## Secrets

Patron: **default global con override per-agent**. Coolify implementa la
herencia nativa — Resource env > Project env. La fuente de verdad real
es la UI de Coolify; este repo solo documenta la convencion en
`profiles/base.yaml -> secrets_ref` y warnea si una key per-agent
falta al compilar.

| Variable | Scope default | Donde la seteas | Override per-agent? |
|---|---|---|---|
| `OPENAI_API_KEY` | **per-agent** | Coolify Resource env | siempre |
| `GEMINI_API_KEY` | **per-agent** | Coolify Resource env | siempre |
| `MINIMAX_API_KEY` | global | Coolify Project env | si — set en Resource |
| `FIRECRAWL_API_KEY` | global | Coolify Project env | si — set en Resource |
| `ELEVENLABS_API_KEY` | global | Coolify Project env | si — set en Resource |
| `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | global | Coolify Project env | si — set en Resource |
| `TELEGRAM_BOT_TOKEN` | per-agent | Coolify Resource env | siempre (entrypoint lo renombra a `TELEGRAM_BOT_TOKEN_<UPPER(AGENT_ID)>`) |
| `TELEGRAM_CHAT_ID` | per-agent | Coolify Resource env | siempre (idem) |

**Mover una key entre scopes** (ej. cuando Minimax pase a per-agent
porque cada participante usa su cuenta) son 30 segundos:

1. Borrar la var del Project env en Coolify.
2. Setear la var en cada Resource individualmente.
3. (Opcional) actualizar `secrets_ref` en `profiles/base.yaml` para
   que la documentacion / warning de compile.py refleje el cambio.

Sin rebuild, sin redeploy del image, sin tocar codigo.

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
