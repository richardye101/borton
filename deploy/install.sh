#!/usr/bin/env bash
# One-shot setup on the LXC: installs the auto-deploy script + systemd timer, then runs an initial deploy.
#   sudo bash deploy/install.sh
# Assumes the borton service unit (receipt-bot) already exists. Override paths with env vars if needed:
#   BORTON_DIR=/root/borton  BORTON_SERVICE=receipt-bot
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"

install -m 755 "$SRC/borton-deploy.sh"      /usr/local/bin/borton-deploy.sh
install -m 644 "$SRC/borton-deploy.service" /etc/systemd/system/borton-deploy.service
install -m 644 "$SRC/borton-deploy.timer"   /etc/systemd/system/borton-deploy.timer

systemctl daemon-reload
systemctl enable --now borton-deploy.timer

echo "Timer enabled. Running an initial deploy now…"
systemctl start borton-deploy.service || true
sleep 1
systemctl status borton-deploy.timer --no-pager -l || true
echo
echo "Done. Follow deploys with:  journalctl -u borton-deploy -f"
