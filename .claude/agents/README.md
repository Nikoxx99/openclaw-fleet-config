# Fleet QA Agents

Equipo de subagents de Claude Code dedicados a hacer QA del fleet-config
antes de cada deploy. Cada uno tiene un scope estrecho y un checklist
verificable; el orquestador (`fleet-coolify-validator`) los corre en orden.

## Roster

| Agent | Scope | Cuando invocarlo |
|---|---|---|
| `fleet-coolify-validator` | Orquestador, veredicto go/no-go | Antes de `git push` o tras un deploy fallido |
| `fleet-dockerfile-auditor` | Dockerfile + entrypoint.sh | Cambios en imagen base, deps, init flow |
| `fleet-compose-auditor` | docker-compose.coolify.yml | Cambios en services, env, volumes, healthcheck |
| `fleet-compile-auditor` | compile.py + schema OpenClaw | Cambios en YAML inputs o lógica de merge/expansion |
| `fleet-paths-auditor` | Consistencia de rutas | Cambios en path defaults o migración de imagen base |
| `fleet-secrets-auditor` | Secrets + env var trazabilidad | PRs con cambios en compose/YAML/.env |

## Uso típico

```
1. Cambias algo (e.g. agregás un provider).
2. Invocas fleet-coolify-validator.
3. El orquestador llama a los demás según corresponda.
4. Corregís FAILs (ningún auditor edita código sin confirmación).
5. Re-corrés validator hasta GO.
6. git push → Coolify deploya con confianza.
```

## Diseño

- **No mutables**: ningún agente edita archivos. Solo reporta + propone.
- **Checklists verificables**: cada agente tiene una lista de items que
  reporta `[OK / WARN / FAIL]` con explicación.
- **Independientes**: corren en paralelo si los invocas individualmente,
  pero el validator los serializa para emular el orden real de boot.
