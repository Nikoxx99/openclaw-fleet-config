---
name: image-generate
description: Generate images via the configured provider chain (primary + fallbacks) with automatic retry, language enforcement on text-in-image, and cost gate. Triggers on any image generation request.
metadata:
  visibility: private
  scope: agentes-fleet
---

# image-generate

Receta determinista para generacion de imagenes. Provider-agnostica: lee
`runtime.image_generation` del YAML del agente y aplica fallback chain.

## Input

```ts
type Input = {
  prompt: string;
  aspect_ratio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  count?: number;               // 1..4, default 1
  has_text_in_image?: boolean;  // si null, inferir por keywords ("cartel", "titulo", "que diga", etc.)
  size?: "standard" | "high";   // afecta coste; default standard
};
```

## Output

```ts
type Output = {
  paths: string[];              // archivos en /tmp/agente-<id>/img-gen/
  provider_used: string;        // ej. "openai/gpt-image-2"
  cost_usd_estimate: number;
  retried: boolean;
};
```

## Procedimiento (orden estricto)

1. **Inferir `has_text_in_image`** si null:
   - Keywords ES/EN que lo activan: `["texto", "cartel", "titulo", "subtitulo",
     "que diga", "que ponga", "logo con", "tipografia", "letras", "text", "sign",
     "title", "caption"]`. Match case-insensitive en `prompt`.

2. **Aplicar regla de idioma** (CRITICA):
   - Si `has_text_in_image === true` AND `runtime.image_generation.spanish_text_in_images === true`,
     APPEND al prompt: `"Any text rendered in the image MUST be written in
     Spanish (Spain). Do not include any text in other languages."`
   - Si `has_text_in_image === false`, NO appendear nada.

3. **Estimar coste** (lookup table):
   ```
   openai/gpt-image-2          standard: $0.04   high: $0.17  per image
   google/gemini-3.1-pro-image-preview   standard: $0.04   high: $0.10  per image
   google/gemini-3-pro-image-preview   DEPRECATED  return error
   openai/gpt-image-1.5        standard: $0.02   high: $0.08  per image (legacy)
   ```
   `cost_estimate = price_per_image * count`.

4. **Cost gate**: si `cost_estimate > 0.50` USD → devolver
   `error: "cost_gate_triggered"` con detalle. El llamador debe pedir
   confirmacion explicita y reintentar con flag interno `cost_confirmed: true`
   (que el agente solo setea tras OK del usuario).

5. **Provider chain**: `chain = [primary, ...fallbacks]` desde
   `runtime.image_generation`. Validar que ningun id esta en deprecated list:
   ```
   ["google/gemini-3-pro-image-preview"]   # deprecated 2026-03-09
   ```
   Si un id esta deprecated → loggear `provider_deprecated` y skipear.

6. **Llamar al primer provider vivo** con timeout `runtime.timeouts_s.image_gen`
   (120s).

7. **Triggers de fallback** (avanzar al siguiente del chain):
   - HTTP 429
   - HTTP 5xx
   - timeout > 30s sin respuesta (early-cut, no esperar 120s)
   - respuesta sin imagen valida (URL invalida o bytes < 1KB)

8. **Persistir** las imagenes en `/tmp/agente-<id>/img-gen/<sha256(prompt)>-<n>.png`.

9. **Si todos los providers fallan** → devolver
   `error: "all_providers_failed"` con detalle por provider:
   `{openai: "503", gemini: "429"}`. NUNCA inventar imagen ni simular exito.

## Reglas duras

- NO generar imagenes con PII de terceros visible en el prompt sin gate de
  `sensitive-image-gate` (lo enforza el hook).
- Cost gate de $0.50 es por request entero (no por imagen individual).
- Timeout por intento: 30s para fallback rapido, 120s antes de declarar fallo
  total.

## Errores estables

| code | causa | accion |
|---|---|---|
| `cost_gate_triggered` | estimacion > $0.50 | pedir confirmacion al usuario |
| `provider_deprecated` | id en lista deprecated | skipear silenciosamente |
| `all_providers_failed` | toda la chain rota | reportar con detalle |
| `prompt_blocked_by_provider` | content policy | reportar; no reintentar |
