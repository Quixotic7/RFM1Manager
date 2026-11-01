#!/bin/zsh
# Double-click in Finder: stops the RFM1Manager server on port 4717.
cd "${0:A:h}"
if [[ -f .server-4717.pid ]] && kill "$(cat .server-4717.pid)" 2>/dev/null; then
  echo "RFM1Manager stopped."
else
  echo "RFM1Manager was not running."
fi
