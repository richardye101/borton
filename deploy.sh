#!/usr/bin/env bash
# One-shot native deploy for a Debian LXC. Run from inside the cloned repo: ./deploy.sh
# (Clone first, copy .env/config.json/cardmap.json in, then run this.)
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(pwd)"

# 1. Node 21+ (api needs global `navigator`) + build tools for better-sqlite3
need_node=1
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 21 ]; then need_node=0; fi
apt-get update
apt-get install -y git curl python3 make g++
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node $(node -v)"

# 2. Private files (gitignored — copy them in before running)
missing=0
for f in .env config.json cardmap.json; do [ -f "$f" ] || { echo "MISSING: $f"; missing=1; }; done
if [ "$missing" -eq 1 ]; then
  echo "Copy the missing file(s) into $REPO/ (scp from your workstation), then re-run ./deploy.sh"
  exit 1
fi
chmod 600 .env

# 3. Deps (compiles better-sqlite3 for this Node's ABI)
npm ci

# 4. systemd service, with WorkingDirectory pointed at this repo
sed "s#^WorkingDirectory=.*#WorkingDirectory=$REPO#" receipt-bot.service > /etc/systemd/system/receipt-bot.service
systemctl daemon-reload
systemctl enable --now receipt-bot
systemctl restart receipt-bot

echo
echo "Deployed. Follow logs:  journalctl -u receipt-bot -f"
