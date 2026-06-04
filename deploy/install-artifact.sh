#!/usr/bin/env bash
set -euo pipefail

ARTIFACT="${1:-}"
APP_ROOT="${APP_ROOT:-/opt/stock-portfolio}"
SERVICE_NAME="${SERVICE_NAME:-stock-portfolio}"
RUN_USER="${RUN_USER:-stockapp}"
RUN_GROUP="${RUN_GROUP:-stockapp}"
RESTART_SERVICE="${RESTART_SERVICE:-1}"
ENV_FILE="${ENV_FILE:-/etc/stock-portfolio.env}"

if [ -z "$ARTIFACT" ]; then
  echo "Usage: sudo bash deploy/install-artifact.sh /path/to/stock-portfolio-*.tar.gz"
  exit 1
fi

if [ ! -f "$ARTIFACT" ]; then
  echo "Artifact not found: $ARTIFACT"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root, for example: sudo bash deploy/install-artifact.sh $ARTIFACT"
  exit 1
fi

STORAGE_DRIVER_VALUE=""
if [ -f "$ENV_FILE" ]; then
  STORAGE_DRIVER_VALUE="$(sed -n 's/^STORAGE_DRIVER=//p' "$ENV_FILE" | tail -n 1 | tr -d '"')"
fi
STORAGE_DRIVER_VALUE="${STORAGE_DRIVER_VALUE:-sqlite}"

if [ "$STORAGE_DRIVER_VALUE" = "sqlite" ] && ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required when STORAGE_DRIVER=sqlite."
  echo "Install it first, for example: sudo apt-get install -y sqlite3 or sudo yum install -y sqlite."
  exit 1
fi

RELEASES_DIR="$APP_ROOT/releases"
RELEASE_ID="$(date +%Y%m%d%H%M%S)"
RELEASE_PATH="$RELEASES_DIR/$RELEASE_ID"

mkdir -p "$RELEASE_PATH"
tar -xzf "$ARTIFACT" -C "$RELEASE_PATH"

if [ ! -f "$RELEASE_PATH/server/server.js" ] || [ ! -f "$RELEASE_PATH/dist/index.html" ]; then
  echo "Invalid artifact: expected server/server.js and dist/index.html"
  exit 1
fi

if id "$RUN_USER" >/dev/null 2>&1; then
  chown -R "$RUN_USER:$RUN_GROUP" "$RELEASE_PATH"
fi

if [ -e "$APP_ROOT/current" ] && [ ! -L "$APP_ROOT/current" ]; then
  echo "$APP_ROOT/current exists and is not a symlink. Move it away before using release-based deploys."
  exit 1
fi

ln -sfn "$RELEASE_PATH" "$APP_ROOT/current"

if [ "$RESTART_SERVICE" != "1" ]; then
  echo "Service restart skipped. Set RESTART_SERVICE=1 or restart $SERVICE_NAME manually."
elif command -v systemctl >/dev/null 2>&1; then
  systemctl restart "$SERVICE_NAME"
  systemctl status "$SERVICE_NAME" --no-pager --lines=20
else
  echo "systemctl not found. Restart the Node service manually."
fi

echo "Deployed $RELEASE_PATH"
