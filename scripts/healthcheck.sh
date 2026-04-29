#!/usr/bin/env bash
# healthcheck.sh — Coolify cada 30s.
# Endpoint real del gateway OpenClaw: puerto 18789, path /healthz.
set -euo pipefail
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
curl -sf --max-time 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null
