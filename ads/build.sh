#!/bin/sh
# One command: demo screenshots, then every ad. Output: ClaudeTerm_Instagram/v2/
set -e
cd "$(dirname "$0")/.."
TMP="${TMPDIR:-/tmp}/claudeterm-ads"
rm -rf "$TMP"
SCENES=$(node -e "console.log(require('./ads/ads.json').scenes.join(','))")
CLAUDETERM_DEMO=1 CLAUDETERM_DATA="$TMP/data" CLAUDETERM_SHOT="$TMP/shots" CLAUDETERM_SCENES="$SCENES" \
  CLAUDETERM_WIDTH=1440 CLAUDETERM_HEIGHT=900 npx electron .
npx electron ads/render.js "$TMP/shots" ClaudeTerm_Instagram/v2
echo "Ads: ClaudeTerm_Instagram/v2"
