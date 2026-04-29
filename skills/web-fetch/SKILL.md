---
name: web-fetch
description: Fetch information from the web by deterministically routing to Firecrawl search, scrape, or interact based on the request shape. Use whenever the agent needs anything web-related.
metadata:
  visibility: private
  scope: agentes-fleet
---

# web-fetch

Routing determinista sobre `firecrawl/firecrawl`. NO crea sesion ni hace
networking propio — solo decide que endpoint llamar y con que parametros.

## Input

```ts
type Input = {
  query: string;                // pregunta o URL o instruccion
  url?: string;                 // si el llamador ya tiene URL especifica
  interactive_hint?: boolean;   // override manual del routing
};
```

## Output

```ts
type Output = {
  mode: "search" | "scrape" | "interact";
  result: unknown;              // payload crudo de firecrawl
  source_urls: string[];        // URLs efectivamente tocadas
};
```

## Decision tree (orden estricto, primer match gana)

1. **`interactive_hint === true`** → `mode: "interact"`.
2. **`url` tiene valor** AND `query` contiene cualquiera de
   `["login", "click", "fill", "submit", "form", "boton", "logueate", "ver mas"]`
   → `mode: "interact"` con `startUrl: url`.
3. **`url` tiene valor** (sin keywords interactivas) → `mode: "scrape"`.
4. **`query` parsea como URL valida** (regex
   `/^https?:\/\/[^\s]+$/`) → `mode: "scrape"` con `url = query`.
5. **default** → `mode: "search"`.

## Llamadas por modo

### search
```ts
firecrawl.search({
  query,
  limit: 5,
  scrapeOptions: { formats: ["markdown"] }
})
```
Devolver top 5 con titulo + url + summary.

### scrape
```ts
firecrawl.scrape({
  url,
  formats: ["markdown"],
  onlyMainContent: true,
  timeout: runtime.timeouts_s.scraping * 1000  // 60s default
})
```

### interact
```ts
firecrawl.interact({
  startUrl: url,
  actions: <generadas desde query>,
  sessionTtl: 600,        // 10 min
  inactivityTtl: 300,     // 5 min
})
```
Las `actions` son lenguaje natural pasado tal cual al endpoint
(ej. `["click 'Ver mas'", "fill email con ejemplo@x.com", "submit"]`).

## Reglas duras

- **Confirmacion** requerida si `mode === "interact"` Y la URL pertenece a
  `policies.private_domains` del agente (lista de dominios donde el owner
  puede tener login activo). Lo enforza `confirm-high-impact` hook.
- Respetar `robots.txt` (Firecrawl lo hace por defecto; NO desactivar).
- Timeout duro por request: `runtime.timeouts_s.scraping` (60s).
- Si Firecrawl 429 → backoff via reliability hook.

## Errores estables

| code | causa | accion |
|---|---|---|
| `firecrawl_rate_limited` | 429 tras retries | reportar y reintentar mas tarde |
| `firecrawl_robots_blocked` | dominio prohibe scraping | informar al usuario |
| `interact_session_expired` | TTL acabado | reabrir sesion una vez |
| `query_empty` | query y url ambos vacios | error temprano |
