---
name: image-preprocess
description: Normalize incoming images (HEIC, oversized, weird formats) into a canonical JPG with a stable hash for dedup. Triggers on any incoming image attachment before analysis or storage.
metadata:
  visibility: private
  scope: agentes-fleet
---

# image-preprocess

Receta determinista de pre-procesamiento. Corre ANTES de cualquier analisis
multimodal o persistencia.

## Input

```ts
type Input = {
  path: string;                 // archivo entrante (cualquier formato comun)
};
```

## Output

```ts
type Output = {
  path: string;                 // canonical jpg en /tmp/agente-<id>/img/<hash>.jpg
  hash: string;                 // sha256 del binario canonical
  width: number;
  height: number;
  size_bytes: number;
  mime: "image/jpeg";
  was_converted: boolean;
  was_downsized: boolean;
};
```

## Procedimiento (orden estricto)

1. **Detectar mime** con `file --mime-type -b <path>`. Lista soportada:
   - `image/jpeg`, `image/png`, `image/webp` → directos.
   - `image/heic`, `image/heif` → convertir con `pillow-heif`.
   - `image/gif` → tomar frame 0 con `ffmpeg -i in.gif -vframes 1 out.jpg`.
   - cualquier otro → error `image_unsupported_mime`.

2. **Convertir a JPG** si no es ya `image/jpeg`:
   ```python
   from PIL import Image
   import pillow_heif; pillow_heif.register_heif_opener()
   Image.open(path).convert("RGB").save("/tmp/.../tmp.jpg", "JPEG", quality=92)
   ```
   `was_converted = true`.

3. **Medir dimensiones**: si `max(width, height) > 2048` O `size_bytes > 4_000_000`,
   re-encodar:
   ```python
   img.thumbnail((2048, 2048), Image.LANCZOS)
   img.save(out, "JPEG", quality=88, optimize=True)
   ```
   `was_downsized = true`.

4. **Hashear**: `sha256sum out.jpg` → primeros 16 chars hex.

5. **Persistir** en `/tmp/agente-<id>/img/<hash>.jpg`. Si ya existe (mismo hash),
   reusar — **no re-procesar**.

6. **Devolver** el schema `Output`.

## Reglas duras

- NO escribir fuera de `/tmp/agente-<id>/img/`.
- NO subir la imagen a ningun servicio externo en este paso. (Eso es
  responsabilidad de `image-analysis` y va con `sensitive-image-gate` antes.)
- Imagenes corruptas (PIL lanza `UnidentifiedImageError`) → error
  `image_corrupt`, no reintentar.

## Errores estables

| code | causa | accion |
|---|---|---|
| `image_unsupported_mime` | formato no soportado | reportar usuario |
| `image_corrupt` | archivo invalido | reportar usuario |
| `image_too_large_post_resize` | aun > 4MB tras resize | bajar quality a 75 + retry una vez |
