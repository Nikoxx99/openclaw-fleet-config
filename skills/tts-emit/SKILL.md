---
name: tts-emit
description: Generate voice audio from text using the configured TTS provider. Triggers ONLY when user explicitly asks for audio ("dime en audio", "mandamelo por voz", "audio") or when the calling tool sets tts:true.
metadata:
  visibility: private
  scope: agentes-fleet
---

# tts-emit

Receta determinista para emitir audio. Provider-agnostica: lee `runtime.tts` de
la config del agente. Soporta Minimax (`speech-2.8-hd`) y OpenAI
(`gpt-4o-mini-tts`).

## Trigger

NO emitir audio por defecto. Solo si:

- El mensaje del usuario matchea regex (case-insensitive):
  `/(en audio|por voz|leelo|escuchame|mandam[e|elo] (un )?audio)/i`.
- O la herramienta llamadora pasa `{tts: true}` explicito en el contexto.

Si ninguna condicion → devolver el texto plano y NO invocar este skill.

## Input

```ts
type Input = {
  text: string;
  voice_override?: string;     // si null, usar runtime.tts.voice_id
};
```

## Output

```ts
type Output = {
  audio_path: string;          // mp3 final en /tmp/agente-<id>/tts/<hash>.mp3
  duration_s: number;
  chunks_concat: number;       // 1 si no hubo chunking
};
```

## Procedimiento

1. **Leer config**:
   - `provider = runtime.tts.provider`
   - `model = runtime.tts.model`
   - `voice = voice_override ?? runtime.tts.voice_id`
   - `chunk_max = runtime.tts.chunk_max_chars` (default 4096)

2. **Decidir chunking**:
   - `len(text) <= chunk_max` → llamada unica, paso 4.
   - `len(text) > chunk_max` → split por parrafos (`\n\n`); si algun parrafo
     supera `chunk_max`, split por oraciones (`.`, `?`, `!`); si aun supera,
     hard-split en `chunk_max - 100` con guion al final del corte.

3. **Numerar chunks** preservando orden estricto.

4. **Llamar al provider** segun `provider`:
   - `minimax` → POST `/v1/t2a_v2` con `{model, voice_id, text}`. Header
     `Authorization: Bearer ${MINIMAX_API_KEY}`. Output mp3 base64 en
     `data.audio`.
   - `openai` → POST `/v1/audio/speech` con `{model, voice, input: text,
     response_format: "mp3"}`. Header `Authorization: Bearer ${OPENAI_API_KEY}`.

5. **Concatenar** (solo si > 1 chunk): `ffmpeg -f concat -safe 0 -i list.txt
   -c copy out.mp3`. La lista preserva orden numerico.

6. **Persistir** en `/tmp/agente-<id>/tts/<sha256(text)>.mp3`.

7. **Errores**:
   - 429 → backoff exponencial (3 intentos) via reliability hook.
   - 5xx → reintento; si persiste, fallback a texto plano y notificar
     `"no pude generar audio: <provider> 5xx"`.
   - 4xx (excepto 429) → fallback inmediato a texto, NO reintentar.

## Reglas duras

- Timeout total: `runtime.timeouts_s.tts` (60s).
- NUNCA enviar audio cuando el contenido contiene secretos detectados por
  `secret-redaction` hook (este corta antes; solo loggear).
- Si la voz solicitada no existe en el provider → usar `runtime.tts.voice_id`
  default y notificar al usuario en una linea.

## Errores estables

| code | causa | accion |
|---|---|---|
| `tts_rate_limited` | 429 tras 3 reintentos | fallback texto |
| `tts_provider_down` | 5xx tras 3 reintentos | fallback texto |
| `tts_voice_unknown` | voice no existe | usar default + notificar |
| `tts_text_empty` | input vacio | error temprano |
