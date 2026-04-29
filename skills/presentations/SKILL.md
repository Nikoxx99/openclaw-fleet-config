---
name: presentations
description: Generate editorial-grade slide presentations as PDF using reveal.js + React + Puppeteer, then deliver via file-deliver. Triggers on requests like "haz una presentacion", "armame un deck", "presentacion sobre X".
metadata:
  visibility: private
  scope: agentes-fleet
  templates_dir: agentes/skills/presentations/templates
---

# presentations

Pipeline determinista para presentaciones con calidad editorial. Stack fijo,
componentes reusables, export PDF, entrega por `file-deliver`.

## Input

```ts
type Input = {
  topic: string;                       // tema central
  audience?: string;                   // ej. "inversores", "equipo"
  num_slides?: number;                 // default 6, clamp [4..12]
  data_points?: { label: string; value: string }[];   // KPIs / stats / quotes
  output_name?: string;                // default slugify(topic)
};
```

## Output

```ts
type Output = {
  pdf_path: string;                    // /tmp/agente-<id>/decks/<name>_v<N>.pdf
  delivered: boolean;                  // true si file-deliver tuvo exito
  slides_used: { component: string; props_keys: string[] }[];
};
```

## Stack tecnico (NO sustituir)

| Capa | Herramienta |
|---|---|
| Bundler | Vite (`npm create vite@latest -- --template react-ts`) |
| UI | React 18 + TypeScript |
| Slides | `reveal.js` + `@revealjs/react` |
| Estilos | Tailwind CSS + CSS global |
| Fuentes | Inter (sans) + Fraunces (display) — Google Fonts |
| Iconos | `lucide-react` (SVG inline; nunca PNG, nunca emoji) |
| Export | Puppeteer headless con `?print-pdf` |

### Deps exactas
```bash
npm i reveal.js @revealjs/react react react-dom lucide-react
npm i -D @types/react @types/react-dom typescript vite @vitejs/plugin-react
npm i -D tailwindcss @tailwindcss/vite puppeteer
```

## Procedimiento

1. **Pedir minimo** (max 1 ronda): titulo, audiencia, num_slides (default 6),
   datos clave (KPIs, quotes). Si el usuario ya los dio, NO preguntar.

2. **Resolver paths**:
   - `name = output_name ?? slugify(topic)`
   - `version = max(N) + 1` mirando `/tmp/agente-<id>/decks/<name>_v*/`
   - `project_dir = /tmp/agente-<id>/decks/<name>_v<version>/`

3. **Scaffold** copiando desde `agentes/skills/presentations/templates/` o
   creando con `npm create vite@latest`:
   ```
   <project_dir>/
   ├── package.json, vite.config.ts, tsconfig.json, index.html
   ├── scripts/export-pdf.mjs
   ├── src/
   │   ├── main.tsx, App.tsx
   │   ├── styles/{global.css, reveal-overrides.css}
   │   ├── theme/{tokens.ts, components.tsx}
   │   └── slides/*.tsx
   └── dist/   (build)
   ```

4. **Plan compositivo** (CRITICO, antes de escribir JSX): generar 2 lineas por
   slide describiendo estructura. Forzar ROTACION — ningun slide repite el
   layout del anterior. Loggear el plan al user en una linea agregada.

5. **Catalogo de slides** (rotar obligatorio):
   1. `CoverSlide` — hero number 140px serif, asimetrico, mesh oscuro
   2. `HeaderBandGridSlide` — banda oscura arriba + grid 2x2 cards
   3. `NumberedRowsSlide` — filas 01..04 con numeros serif gigantes
   4. `StatBandSlide` — banda horizontal con 3-4 KPIs 90px+
   5. `BigNumberSideRowsSlide` — KPI hero 120px izq + filas der
   6. `MetricsProgressSlide` — 4 col con label + valor + barra
   7. `QuoteSlide` — pull quote serif gigante centrada
   8. `ComparisonSlide` — dos paneles A/B
   9. `TimelineSlide` — linea con hitos y fechas serif
   10. `ClosingSlide` — composicion asimetrica con CTA

6. **Tipografia (tokens)**:
   ```ts
   // src/theme/tokens.ts
   export const type = {
     eyebrow:   { size: 12, weight: 600, tracking: 0.15, upper: true },
     label:     { size: 13, weight: 500 },
     body:      { size: 15, weight: 400 },
     subtitle:  { size: 20, weight: 500, tracking: -0.01 },
     cardTitle: { size: 24, weight: 600, tracking: -0.02 },
     section:   { size: 42, weight: 700, tracking: -0.03 },
     hero:      { size: 120, weight: 800, font: "serif", tracking: -0.04 },
   };
   ```
   **Regla**: cada slide expone minimo 3 niveles tipograficos visibles.

7. **Paleta** (tokens):
   ```ts
   export const color = {
     accent1: "#c026d3",  // fucsia (highlights/CTA)
     accent2: "#9333ea",  // purpura
     accent3: "#7c3aed",
     bg: { lightA: "#ffffff", lightB: "#faf5ff", darkA: "#1e1b2e", darkB: "#0f0a1f" },
     text:    { strong: "#111827", mid: "#374151", soft: "#6b7280" },
     border:  "rgba(192,38,211,0.08)",
     warn:    "#ef4444",  // SOLO si hay dato negativo, max 1 vez por deck
   };
   ```
   **Prohibido**: verde, azul, naranja, amarillo (excepto warn 1 vez), negro
   puro, mas de 2 acentos saturados por slide.

8. **Reveal config** (CRITICO para PDF):
   ```ts
   const config = {
     width: 1920, height: 1080, margin: 0, minScale: 1, maxScale: 1,
     transition: "none", backgroundTransition: "none",
     controls: false, progress: false, slideNumber: false, hash: false,
     center: false,
     pdfSeparateFragments: false, pdfMaxPagesPerSlide: 1, pdfPageHeightOffset: 0,
     view: undefined, plugins: [],
   };
   ```

9. **Build**: `cd <project_dir> && npm install && npm run build`.

10. **Servir + export PDF**:
    ```bash
    npx serve dist -p 4173 -s &
    SERVER_PID=$!
    sleep 2
    OUT=/tmp/agente-<id>/decks/<name>_v<version>.pdf node scripts/export-pdf.mjs
    kill $SERVER_PID
    ```
    Script `export-pdf.mjs` usa Puppeteer con viewport 1920x1080,
    `waitUntil: networkidle0`, buffer 2s para fuentes/SVG, `page.pdf` con
    `width:1920px height:1080px printBackground:true preferCSSPageSize:true`.

11. **Entregar** el PDF llamando `file-deliver` con
    `display_name: "<name>-<YYYY-MM-DD>.pdf"`. NUNCA enviar HTML, codigo,
    rutas internas, ni el zip del proyecto.

## Tecnicas visuales obligatorias (minimo 4 por presentacion)

1. Asimetria intencional (60/40, 70/30; nunca 50/50).
2. >= 1 numero gigante serif (80px+) por slide (excepto quote).
3. Eyebrows encima de cada titulo principal.
4. Lineas divisorias 1px @ 15-20% opacidad accent.
5. Pills/badges para etiquetas (`NEW`, `+12%`).
6. Mesh gradients sutiles en covers.
7. Progress bars lineales (nunca circulares).
8. Numeracion de slide visible en esquina (estilo eyebrow).
9. Iconos lucide-react inline.
10. Tablas sin bordes verticales, solo horizontales sutiles.

## Densidad

- Margen exterior slide: minimo 64px en los 4 lados.
- Gap entre cards: 20-32px.
- `line-height` body 1.5-1.6, headings 1.05-1.15.
- Regla 60/30/10: 60% fondo neutro, 30% contenido, 10% acento.

## Anti-patrones (PROHIBIDO)

- Cards identicas en grid simetrico perfecto.
- Titulos sin eyebrow.
- Fondos planos sin elemento decorativo.
- Texto centrado por defecto (preferir izquierda salvo cover/quote).
- Iconos rellenos pesados (usar outline).
- Drop shadows estilo PowerPoint 2010.
- > 6 elementos compitiendo en el mismo slide.

## Checklist pre-entrega (TODO debe ser true)

- [ ] Cada slide tiene estructura distinta a la anterior.
- [ ] >= 3 niveles tipograficos visibles por slide.
- [ ] >= 1 numero/stat hero serif por slide (excepto quote).
- [ ] Eyebrows presentes sobre titulos.
- [ ] Iconos SVG inline via lucide-react.
- [ ] Paleta limitada a fucsia + purpura + neutros (+ rojo max 1x).
- [ ] Margen exterior >= 64px.
- [ ] Numeracion de slide visible.
- [ ] `transition: 'none'` en config.
- [ ] PDF sale 1920x1080 sin bordes blancos.
- [ ] Solo el PDF entregado al usuario (no HTML, no codigo).

## Errores estables

| code | causa | accion |
|---|---|---|
| `vite_install_failed` | npm install fallo | reportar y NO seguir |
| `puppeteer_launch_failed` | sandbox/perms | revisar `--no-sandbox` |
| `pdf_export_blank` | red/font no cargo | reintentar 1 vez con buffer 5s |
| `checklist_failed` | algun item false | rehacer slides ofensores |
