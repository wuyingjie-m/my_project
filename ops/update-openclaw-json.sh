#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  update-openclaw-json-field.sh <root_dir> <field_path> <new_value>

Examples:
  update-openclaw-json-field.sh /data/agent channels.feishu.dmPolicy allowlist
  update-openclaw-json-field.sh /data/agent channels.feishu.enabled true
  update-openclaw-json-field.sh /data/agent gateway.auth.token '"new-token"'

Notes:
  - Recursively finds files named openclaw.json under <root_dir>.
  - Creates a timestamped .bak backup next to each modified file.
  - <field_path> uses dot notation, for example: channels.feishu.dmPolicy
  - <new_value> is parsed as JSON when possible: true, false, null, numbers,
    arrays, objects, and quoted strings are preserved as JSON values.
    Unquoted non-JSON values are treated as strings.
EOF
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

ROOT_DIR=$1
FIELD_PATH=$2
NEW_VALUE_RAW=$3

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "ERROR: root_dir does not exist or is not a directory: $ROOT_DIR" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not found in PATH" >&2
  exit 1
fi

if [[ -z "$FIELD_PATH" || "$FIELD_PATH" == .* || "$FIELD_PATH" == *..* || "$FIELD_PATH" == *. ]]; then
  echo "ERROR: invalid field_path: $FIELD_PATH" >&2
  exit 1
fi

timestamp=$(date +%Y%m%d-%H%M%S)
updated=0
failed=0

while IFS= read -r -d '' file; do
  tmp=$(mktemp)
  backup="${file}.bak-${timestamp}"

  if ! jq empty "$file" >/dev/null 2>&1; then
    echo "SKIP invalid JSON: $file" >&2
    failed=$((failed + 1))
    rm -f "$tmp"
    continue
  fi

  if jq --arg path "$FIELD_PATH" --arg raw "$NEW_VALUE_RAW" '
      def parse_value:
        try ($raw | fromjson) catch $raw;

      setpath($path | split("."); parse_value)
    ' "$file" > "$tmp"; then
    cp -p "$file" "$backup"
    mv "$tmp" "$file"
    echo "OK   $file"
    echo "     backup: $backup"
    updated=$((updated + 1))
  else
    echo "FAIL $file" >&2
    failed=$((failed + 1))
    rm -f "$tmp"
  fi
done < <(find "$ROOT_DIR" -type f -name openclaw.json -print0)

echo
echo "Done. updated=$updated failed=$failed"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi

