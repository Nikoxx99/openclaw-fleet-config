#!/usr/bin/env python3
"""compile.py — Convierte profiles/base.yaml + agents/<id>.yaml en los
artefactos que OpenClaw consume:

    openclaw.json        — config principal del harness
    fleet-policies.json  — bloques no-core (timeouts, retry, rate_limits, etc.)
                           que los hooks privados leen
    prompt.md            — identidad + judgment_rules del agente

Reglas de merge (delta sobre base):
  - dict   → recursivo (delta sobreescribe key a key)
  - list   → delta reemplaza completo (NO se concatena)
  - scalar → delta gana
  - None en delta → borra la key del base

Reglas de expansion de variables:
  - "${FOO}" en cualquier string se reemplaza por os.environ["FOO"]
  - "${FOO:-default}" usa default si FOO no esta definida
  - Si una "${FOO}" requerida no existe → error con detalle.

Uso:
  python3 compile.py --base profiles/base.yaml \\
                     --agent agents/<id>.yaml \\
                     --out-dir $OPENCLAW_HOME
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import yaml

VAR_RE = re.compile(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}")


def expand_vars(value: Any, missing: list[str]) -> Any:
    if isinstance(value, str):
        def repl(m: re.Match[str]) -> str:
            name, default = m.group(1), m.group(2)
            if name in os.environ:
                return os.environ[name]
            if default is not None:
                return default
            missing.append(name)
            return m.group(0)
        return VAR_RE.sub(repl, value)
    if isinstance(value, dict):
        return {k: expand_vars(v, missing) for k, v in value.items()}
    if isinstance(value, list):
        return [expand_vars(v, missing) for v in value]
    return value


def deep_merge(base: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in delta.items():
        if v is None and k in out:
            del out[k]
            continue
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def build_provider_outputs(
    merged: dict[str, Any], env: dict[str, str]
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Genera los 3 bloques que OpenClaw necesita por provider:
       - plugins.entries.<name>.enabled = true
       - auth.profiles.<auth_profile> (LLM providers solo)
       - models.providers.<name> (providers con config custom: baseUrl, etc.)

    Skip silencioso si api_key_env no esta seteada.
    """
    providers_cfg = merged.get("providers", {}) or {}
    plugins_entries: dict[str, Any] = {}
    auth_profiles: dict[str, Any] = {}
    models_providers: dict[str, Any] = {}

    for name, cfg in providers_cfg.items():
        if not isinstance(cfg, dict):
            continue

        # Plugins always-on (sin api key, ej. browser).
        if cfg.get("always_enabled"):
            plugins_entries[name] = {"enabled": True}
            continue

        env_var = cfg.get("api_key_env")
        if not env_var:
            continue
        api_key = env.get(env_var, "")
        if not api_key:
            continue  # skip silencioso

        entry: dict[str, Any] = {"enabled": True}

        # Caso especial firecrawl: la API key va en plugin.config.webSearch.apiKey.
        if name == "firecrawl":
            entry["config"] = {"webSearch": {"apiKey": api_key}}

        plugins_entries[name] = entry

        # Auth profile (solo LLM providers).
        auth_profile = cfg.get("auth_profile")
        if auth_profile:
            auth_profiles[auth_profile] = {
                "provider": name,
                "mode": "api_key",
            }

        # models.providers entry — solo si el provider declaro `config`
        # (caso minimax con baseUrl custom + api anthropic-messages).
        provider_config = cfg.get("config")
        if provider_config and isinstance(provider_config, dict):
            models_providers[name] = {**provider_config, "apiKey": api_key}

    return plugins_entries, auth_profiles, models_providers


def to_openclaw_json(
    merged: dict[str, Any], env: dict[str, str] | None = None
) -> dict[str, Any]:
    """Mapea el schema YAML al shape que el harness OpenClaw espera.
    El JSON resultante imita la estructura de un openclaw.json valido.
    """
    if env is None:
        env = dict(os.environ)
    rt = merged.get("runtime", {})
    tts = rt.get("tts", {})
    providers_cfg = merged.get("providers", {}) or {}

    plugins_entries, auth_profiles, models_providers = build_provider_outputs(
        merged, env
    )

    out: dict[str, Any] = {
        "gateway": {
            "port": merged.get("gateway", {}).get("port", 18789),
            "mode": merged.get("gateway", {}).get("mode", "local"),
            "bind": merged.get("gateway", {}).get("bind", "loopback"),
        },
        "agents": {
            "defaults": {
                "workspace": rt.get("workspace", "/home/node/.openclaw/workspace"),
                "model": rt.get("model", {}),
                "imageModel": rt.get("image_input", {}),
                "imageGenerationModel": rt.get("image_generation", {}),
            }
        },
        "channels": merged.get("channels", {}),
        "tools": merged.get("tools", {}),
        "session": {
            "dmScope": merged.get("session", {}).get("dm_scope", "per-channel-peer"),
        },
        "skills": {
            "install": {"nodeManager": "npm"},
        },
        "hooks": merged.get("hooks", {"internal": {"enabled": True}}),
    }

    if plugins_entries:
        out["plugins"] = {"entries": plugins_entries}
    if auth_profiles:
        out["auth"] = {"profiles": auth_profiles}
    if models_providers:
        out["models"] = {"providers": models_providers, "mode": "merge"}

    if tts:
        tts_provider_name = tts.get("provider")
        tts_provider_meta = providers_cfg.get(tts_provider_name, {}) or {}
        tts_api_key = env.get(tts_provider_meta.get("api_key_env", ""), "")
        provider_block: dict[str, Any] = {
            "model": tts.get("model"),
            "voiceId": tts.get("voice_id"),
        }
        if tts_api_key:
            provider_block["apiKey"] = tts_api_key
        out["messages"] = {
            "tts": {
                "enabled": tts.get("enabled", False),
                "mode": tts.get("mode", "final"),
                "provider": tts_provider_name,
                "providers": {tts_provider_name: provider_block},
            }
        }
    return out


def to_fleet_policies(merged: dict[str, Any]) -> dict[str, Any]:
    rt = merged.get("runtime", {})
    return {
        "agent_id": merged.get("id"),
        "timeouts_s": rt.get("timeouts_s", {}),
        "retry": rt.get("retry", {}),
        "circuit_breaker": rt.get("circuit_breaker", {}),
        "sandbox": rt.get("sandbox", {}),
        "health": rt.get("health", {}),
        "crash_recovery": rt.get("crash_recovery", {}),
        "observability": merged.get("observability", {}),
        "policies": merged.get("policies", {}),
        "hooks_pretool": merged.get("hooks_pretool", []),
        "hooks_posttool": merged.get("hooks_posttool", []),
        "hooks_session_start": merged.get("hooks_session_start", []),
        "owner_email": merged.get("identity", {}).get("owner"),
    }


def to_prompt_md(merged: dict[str, Any]) -> str:
    ident = merged.get("identity", {})
    rules = ident.get("judgment_rules", [])
    name = ident.get("name", merged.get("id", "agent"))
    owner = ident.get("owner", "")
    locale = ident.get("locale", "es-ES")
    tone = ident.get("tone", "directo")
    lines = [
        f"# {name}",
        "",
        f"Owner: {owner}" if owner else "",
        f"Locale: {locale}",
        f"Tono: {tone}",
        "",
        "## Reglas de juicio (no-codificables)",
        "",
    ]
    for r in rules:
        lines.append(f"- {r}")
    lines.append("")
    lines.append("## Capacidades")
    lines.append("")
    lines.append("Tus capacidades vienen de las skills montadas en `~/.openclaw/skills/`.")
    lines.append("Tus politicas (timeouts, retry, gates de confirmacion, redaccion de secretos)")
    lines.append("vienen de los hooks en `/opt/hooks/`. NO replicar logica de skills/hooks en")
    lines.append("este prompt — son determinisitas y vives encima de ellas.")
    return "\n".join(l for l in lines if l is not None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", type=Path, required=True)
    ap.add_argument("--agent", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()

    base = load_yaml(args.base)
    delta = load_yaml(args.agent)
    merged = deep_merge(base, delta)

    missing: list[str] = []
    merged = expand_vars(merged, missing)
    if missing:
        unique = sorted(set(missing))
        sys.stderr.write(
            "ERROR: missing required env vars referenced from YAML:\n  - "
            + "\n  - ".join(unique)
            + "\n"
        )
        return 3

    # Warn (don't fail) on missing per-agent secrets. The agent can still
    # boot — providers using those keys will fail at runtime with their own
    # error path, which is more informative than blocking compilation.
    secrets_ref = merged.get("secrets_ref", {})
    if isinstance(secrets_ref, dict):
        per_agent_keys = secrets_ref.get("per_agent", []) or []
        missing_per_agent = [k for k in per_agent_keys if not os.environ.get(k)]
        if missing_per_agent:
            sys.stderr.write(
                "WARNING: per-agent secrets not set in environment "
                f"(agent={merged.get('id')}): "
                + ", ".join(missing_per_agent)
                + "\n"
            )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "openclaw.json").write_text(
        json.dumps(to_openclaw_json(merged), indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (args.out_dir / "fleet-policies.json").write_text(
        json.dumps(to_fleet_policies(merged), indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (args.out_dir / "prompt.md").write_text(to_prompt_md(merged), encoding="utf-8")

    print(f"compiled agent={merged.get('id')} → {args.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
