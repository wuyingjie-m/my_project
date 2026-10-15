#!/usr/bin/env bash
set -euo pipefail

OPS_DIR="/data/agent/ops"

"$OPS_DIR/stop-all.sh"
sleep 2
"$OPS_DIR/start-all.sh"
