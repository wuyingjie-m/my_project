#!/usr/bin/env bash
set -euo pipefail

TAILSCALE_IP="100.108.105.16"

declare -A INSTANCES=(
  [openclaw_GYL]=18790
  [openclaw_PJT]=18791
  [openclaw_QD]=18792
  [openclaw_TeamS]=18793
  [openclaw_GTM]=18794
)

echo "Resetting old Tailscale Serve config..."
tailscale serve reset || true

echo "Publishing OpenClaw instances through Tailscale TCP..."
for name in "${!INSTANCES[@]}"; do
  port="${INSTANCES[$name]}"
  echo "  $name: http://${TAILSCALE_IP}:${port}/ -> 127.0.0.1:${port}"
  tailscale serve --bg --tcp="${port}" "tcp://127.0.0.1:${port}"
done

echo
echo "Done. Open these from your Windows browser:"
for name in "${!INSTANCES[@]}"; do
  port="${INSTANCES[$name]}"
  printf "  %-16s http://%s:%s/\n" "$name" "$TAILSCALE_IP" "$port"
done

echo
echo "Current Tailscale Serve status:"
tailscale serve status
