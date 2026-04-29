---
name: file-deliver
description: Deliver a generated file to the user via Telegram, handling 50MB limits with compression or signed link fallback. Triggers whenever the agent has a file to send.
metadata:
  visibility: private
  scope: agentes-fleet
---

# file-deliver

Receta determinista para entregar archivos. Decide entre attach directo, zip,
o link firmado segun tamano.

## Input

```ts
type Input = {
  path: string;                    // archivo a entregar
  display_name?: string;           // nombre humano; si null, derivar de path
  caption?: string;                // texto adjunto en Telegram
  chat_id?: string | number;       // si null, usar channels.telegram.chat_id del agente
};
```

## Output

```ts
type Output =
  | { mode: "telegram_document"; message_id: number }
  | { mode: "telegram_document_zipped"; message_id: number; ratio: number }
  | { mode: "signed_link"; url: string; expires_at: string; message_id: number };
```

## Procedimiento

1. **NUNCA** enviar la ruta del archivo como texto. La ruta no se menciona al
   usuario en ningun caso. (Reforzado por `path-scrubber` hook.)

2. **Resolver `display_name`**: si null, usar `basename(path)`. Si el nombre es
   un hash (regex `/^[a-f0-9]{16,}$/i`), reemplazar por
   `<tipo>-<YYYY-MM-DD>.<ext>` (ej. `reporte-2026-04-29.pdf`).

3. **Detectar MIME**: `file --mime-type -b <path>`. Mapear a Telegram MIME
   correcto:
   - `.pdf` → `application/pdf`
   - `.docx` → `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
   - `.xlsx` → `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
   - `.pptx` → `application/vnd.openxmlformats-officedocument.presentationml.presentation`
   - default → mime detectado, NUNCA `application/octet-stream`.

4. **Medir tamano**: `stat -c%s <path>`.

5. **Decidir modo**:
   - `size <= 50_000_000` → modo `telegram_document` (paso 6).
   - `size > 50_000_000`:
     a. probar zip: `zip -9 /tmp/.../<name>.zip <path>`. Medir ratio
        `1 - (zipped_size / size)`.
     b. si `ratio > 0.15` AND `zipped_size <= 50_000_000` →
        modo `telegram_document_zipped` con el zip (paso 6).
     c. si no → modo `signed_link` (paso 7).

6. **Enviar a Telegram**:
   ```bash
   curl -s -F document=@<file> \
        -F chat_id=<chat_id> \
        -F caption=<caption> \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument"
   ```
   Parsear `result.message_id` del JSON de respuesta.

7. **Signed link** (R2/S3):
   - Subir a bucket `${R2_BUCKET}` con key `<agent_id>/<sha256>/<display_name>`.
   - Generar URL firmada con TTL 24h (`aws s3 presign --expires-in 86400` o
     equivalente Cloudflare R2).
   - Enviar mensaje a Telegram: `"archivo demasiado grande para Telegram, te
     dejo un link valido 24h: <url>"`.
   - `expires_at = now + 24h ISO8601`.

8. **Errores Telegram**:
   - 413 (file too large) → fallback automatico a signed_link.
   - 429 → backoff via reliability.
   - 5xx → reintento; si persiste, reportar y NO inventar entrega.

## Reglas duras

- Timeout total: `runtime.timeouts_s.telegram_send` (30s) por request.
- Bucket env vars requeridas: `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
  Si faltan y se necesita signed_link → error `signed_link_unconfigured`.
- NUNCA loggear el contenido del archivo, solo metadata.

## Errores estables

| code | causa | accion |
|---|---|---|
| `telegram_send_failed` | 5xx tras retries | reportar al usuario |
| `signed_link_unconfigured` | falta R2 env | reportar y pedir config |
| `file_not_found` | path no existe | error temprano |
