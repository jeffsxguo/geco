#!/usr/bin/env bash
set -euo pipefail

# Install Node.js dependencies for abort-rate tools
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/tools/abort-rate"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Please install Node.js and npm first." >&2
  exit 1
fi

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
