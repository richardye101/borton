#!/usr/bin/env bash
# Poll origin/main; on a new commit: pull -> (npm) -> restart -> health-check -> roll back on failure.
# A no-op tick is a single git fetch (a few KB, a few ms) — see deploy/README.md.
set -euo pipefail

REPO_DIR="${BORTON_DIR:-/root/borton}"
SERVICE="${BORTON_SERVICE:-receipt-bot}"
READY_MARKER="Long-polling"   # the bot logs "Bot running. Long-polling Telegram…" once it's actually up
TIMEOUT=30                    # seconds to wait for that marker before declaring failure

cd "$REPO_DIR"
git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0          # nothing new -> done

echo "Deploying $LOCAL -> $REMOTE"
git reset --hard origin/main
npm ci
npm run build

START=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart "$SERVICE"
WEB_ENABLED=0
if systemctl is-enabled --quiet borton-web 2>/dev/null; then
  WEB_ENABLED=1
  systemctl restart borton-web
fi

# Wait for the bot to report it actually came up (not just that systemd launched the process).
healthy=0
for _ in $(seq 1 "$((TIMEOUT / 2))"); do
  if systemctl is-active --quiet "$SERVICE" \
     && { [ "$WEB_ENABLED" = 0 ] || systemctl is-active --quiet borton-web; } \
     && journalctl -u "$SERVICE" --since "$START" 2>/dev/null | grep -q "$READY_MARKER"; then
    healthy=1; break
  fi
  sleep 2
done

if [ "$healthy" = 1 ]; then
  echo "$REMOTE" > "$REPO_DIR/.last-good"    # remember the known-good commit (used by manual rollback)
  echo "Deploy OK at $REMOTE"
else
  echo "FAILED health check ($TIMEOUT s) — rolling back to $LOCAL"
  git reset --hard "$LOCAL"
  npm ci
  npm run build
  systemctl restart "$SERVICE"
  if [ "$WEB_ENABLED" = 1 ]; then systemctl restart borton-web; fi
  exit 1                                       # marks borton-deploy.service failed in the journal
fi
