#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/openclaw-bot-review-furnace}"
export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-3000}"
export HOSTNAME="${HOSTNAME:-127.0.0.1}"
export OPENCLAW_INSTANCES_DIR="${OPENCLAW_INSTANCES_DIR:-/data/agent}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/data/agent/openclaw_GTM/.openclaw/openclaw.json}"
export OPENCLAW_HOME="${OPENCLAW_HOME:-$(dirname "$OPENCLAW_CONFIG_PATH")}"
export NEXT_PUBLIC_OPENCLAW_GATEWAY_PROXY="${NEXT_PUBLIC_OPENCLAW_GATEWAY_PROXY:-1}"

cd "$APP_DIR"

if [ ! -d node_modules ]; then
  npm ci
fi

if [ ! -d .next ]; then
  npm run build
fi

exec npm run start -- -H "$HOSTNAME" -p "$PORT"
