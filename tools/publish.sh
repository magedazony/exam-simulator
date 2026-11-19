#!/usr/bin/env bash
# Mac/Linux version of publish.bat: send your changes to GitHub and wait until the site has them.
set -e
SITE=https://exam-simulator-k925.onrender.com
cd "$(dirname "$0")/.."
git pull --rebase --autostash origin main
if [ -z "$(git status --porcelain)" ]; then echo "No changes to send."; exit 0; fi
git status --short
read -rp "Describe the change (or Enter): " msg
msg=${msg:-"Update $(date '+%Y-%m-%d %H:%M')"}
read -rp "Send and publish? (y/n) " ok; [ "$ok" = y ] || exit 1
git add -A && git commit -qm "$msg" && git push -q origin main
sha=$(git rev-parse --short=7 HEAD); echo "Sent ($sha). Waiting for the site..."
for i in $(seq 60); do
  sleep 15
  if curl -s -m 20 "$SITE/api/v1/health" | grep -q "\"version\":\"$sha\""; then echo "LIVE: $sha"; exit 0; fi
  echo "  still building... ($((i/4)) min)"
done
echo "Not live after 15 minutes: check dashboard.render.com > Events / Logs."; exit 1
