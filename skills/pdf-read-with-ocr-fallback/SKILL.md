---
name: pdf-read-with-ocr-fallback
description: Extract text from a PDF, automatically falling back to OCR when the PDF is scanned/image-only. Use this for any PDF read; for editing PDFs use openclaw/nano-pdf.
metadata:
  visibility: private
  scope: agentes-fleet
---

# pdf-read-with-ocr-fallback

Receta determinista para leer PDFs. Se decide solo entre nativo y OCR segun
densidad de texto.

## Input

```ts
type Input = {
  path: string;
  password?: string;            // si el PDF lo requiere
  pages?: [number, number];     // rango 1-indexed inclusivo, opcional
};
```

## Output

```ts
type Output = {
  pages: { page: number; text: string }[];
  method: "native" | "ocr";
  chars_per_page_avg: number;
  language?: string;            // solo si method === "ocr"
};
```

## Procedimiento

1. **Verificar archivo**: `file <path>` debe ser `application/pdf`. Si esta
   protegido con password y no hay `password` en input, devolver
   `error: "pdf_password_required"` SIN intentar bruteforce.

2. **Extraccion nativa** con `pdfplumber`:
   ```python
   import pdfplumber
   with pdfplumber.open(path, password=password) as pdf:
       pages = [{"page": i+1, "text": p.extract_text() or ""}
                for i, p in enumerate(pdf.pages)]
   ```

3. **Calcular densidad**:
   `avg = sum(len(p.text) for p in pages) / len(pages)`.

4. **Decidir**:
   - `avg >= 20` → `method = "native"`, devolver pages como estan.
   - `avg < 20` → goto OCR (paso 5).

5. **OCR pipeline**:
   ```bash
   # convertir cada pagina a PNG 300dpi
   pdftoppm -r 300 -png <path> /tmp/.../page
   # OCR con español + ingles
   for png in /tmp/.../page-*.png; do
     tesseract "$png" - -l spa+eng > "${png%.png}.txt"
   done
   ```
   Reconstruir `pages` desde los `.txt`. `method = "ocr"`. Detectar idioma
   dominante con `langdetect` sobre el texto unido (`language` en output).

6. **Cleanup**: borrar `/tmp/.../page-*.png` y `*.txt` al terminar.

## Verificacion de dependencias al arranque

Al cargar el skill, comprobar:
- `pdfplumber` importable (Python).
- `pdftoppm --version` (poppler-utils).
- `tesseract --version` Y `tesseract --list-langs` debe contener `spa` y `eng`.

Si falta cualquiera → loggear `dependency_missing: <bin>` y rechazar la skill.

## Reglas duras

- NUNCA tocar el PDF original (solo lectura).
- NO bruteforcear passwords.
- Si `pages` esta dado, procesar solo ese rango (clamp a `[1, total_pages]`).
- Timeout duro por pagina OCR: 15s. Si excede, marcar pagina con
  `text: "[ocr_timeout]"` y continuar.

## Errores estables

| code | causa | accion |
|---|---|---|
| `pdf_password_required` | encriptado | pedir password al usuario |
| `pdf_corrupt` | pdfplumber falla a abrir | reportar |
| `dependency_missing` | falta tesseract/poppler | reportar instalacion |
| `ocr_partial` | algunas paginas timeoutearon | devolver con marca |
