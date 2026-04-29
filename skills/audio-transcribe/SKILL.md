---
name: audio-transcribe
description: Transcribe audio files (ogg, opus, m4a, wav, mp3) deterministically with Whisper. Triggers on incoming audio attachments or explicit "transcribe" requests.
metadata:
  visibility: private
  scope: agentes-fleet
---

# audio-transcribe

Receta determinista para transcribir audio. Wrapea `openclaw/openai-whisper-api`.

## Input

```ts
type Input = {
  path: string;             // ruta absoluta al archivo de audio
  language?: string;        // ISO 639-1; si null, autodeteccion
};
```

## Output (schema fijo)

```ts
type Output = {
  text: string;             // transcripcion completa, stitched
  segments: { start: number; end: number; text: string; lang: string }[];
  language: string;         // detectado o pasado
  partial: boolean;         // true si se corto por timeout o calidad baja
  duration_s: number;
};
```

## Procedimiento (orden estricto)

1. **Normalizar formato**: si extension no es `.wav`, convertir con
   `ffmpeg -i <path> -ar 16000 -ac 1 -c:a pcm_s16le /tmp/<hash>.wav`.
   Falla → return `error: "ffmpeg_failed"`.

2. **Medir duracion**: `ffprobe -v error -show_entries format=duration -of csv=p=0 <wav>`.

3. **Decidir estrategia segun duracion**:
   - `duration <= 28s` → llamada unica, pasar a paso 6.
   - `28s < duration <= 600s` → chunking simple (paso 4).
   - `duration > 600s` → VAD + chunking (paso 5).

4. **Chunking simple**: dividir en chunks de **28s con overlap de 2s**.
   ```bash
   ffmpeg -i <wav> -f segment -segment_time 26 -segment_overlap 2 \
     -reset_timestamps 1 /tmp/chunk-%03d.wav
   ```

5. **VAD pre-filtro** (audios largos): aplicar `silero-vad` para descartar silencios > 1s.
   Sobre el audio resultante, aplicar paso 4.

6. **Transcribir cada chunk** con `openclaw/openai-whisper-api` (modelo
   `large-v3-int8` cpu / `large-v3-fp16` gpu). Pasar `language` si esta dado.

7. **Stitching**: unir chunks colapsando overlap por similitud sufijo/prefijo
   (matchear ultimos 50 chars de chunk N contra primeros 50 de chunk N+1; si
   match >= 80% similitud, descartar prefijo de N+1).

8. **Timeout duro**: limite total `runtime.timeouts_s.transcription` (180s default).
   Si se excede, devolver lo transcrito con `partial: true`.

9. **Cleanup**: borrar `/tmp/chunk-*.wav` y `/tmp/<hash>.wav`.

## Reglas duras

- NUNCA traducir. Preservar idioma detectado por chunk.
- Calidad baja (Whisper devuelve `confidence < 0.5` promedio) → `partial: true`,
  loggear pero entregar.
- Audios > 10 min Y sin VAD disponible → rechazar con
  `error: "vad_required_unavailable"`. No procesar 10 min en bruto.

## Errores estables

| code | causa | accion del agente |
|---|---|---|
| `ffmpeg_failed` | conversion fallo | reportar al usuario; no reintentar |
| `transcription_timeout` | excedio 180s | devolver parcial |
| `vad_required_unavailable` | audio largo sin silero-vad | reportar e instalar |
| `whisper_api_5xx` | provider caido | reintento via reliability hook |
