#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_NAME="${APP_NAME:-stock-portfolio}"
VERSION="$(node -e "const p = require('./package.json'); console.log(String(p.version || '0.0.0').replace(/[^a-zA-Z0-9._-]/g, '_'))")"
STAMP="$(date +%Y%m%d%H%M%S)"
RELEASE_DIR="${RELEASE_DIR:-release}"
ARTIFACT="${RELEASE_DIR}/${APP_NAME}-${VERSION}-${STAMP}.tar.gz"

mkdir -p "$RELEASE_DIR"

if [ "${SKIP_NPM_CI:-0}" != "1" ]; then
  npm ci
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm run build
fi

if [ ! -f dist/index.html ]; then
  echo "dist/index.html not found. Run npm run build first, or provide an existing dist/ and set SKIP_BUILD=1."
  exit 1
fi

COPYFILE_DISABLE=1 tar -czf "$ARTIFACT" \
  dist \
  server \
  deploy \
  .env.production.example \
  package.json

echo "$ARTIFACT"
