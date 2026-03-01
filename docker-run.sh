#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Building and starting Node.js CLI server (port 8047)..."
docker compose up --build "$@"
