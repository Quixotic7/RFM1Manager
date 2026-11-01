#!/bin/zsh
# Double-click in Finder: starts RFM1Manager (if not already running) and opens it in your browser.
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
URL="http://127.0.0.1:4717/"
if ! curl -s -o /dev/null "$URL"; then
  mkdir -p logs
  nohup node server.js >> logs/server.log 2>&1 &
  for i in {1..20}; do curl -s -o /dev/null "$URL" && break; sleep 0.5; done
fi
open "$URL"
echo "RFM1Manager is running at $URL (log: logs/server.log). You can close this window."
