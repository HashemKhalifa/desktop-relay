#!/usr/bin/env bash
# Runs under launchd StartInterval=60. Local readiness every run; public probe at a
# cadence that respects the provider's request quota (ngrok free: ~20k req/mo →
# public probe every 15 min ≈ 2,880/mo). Failure classes get different responses:
# dead local daemon -> kickstart it; public unreachable -> limited tunnel restart;
# quota/auth failures -> alert only, never a restart loop.
set -u
CONFIG_DIR="${HOME}/.config/desktop-relay"
CONFIG="${CONFIG_DIR}/config.json"
LOGDIR="${HOME}/Library/Logs/desktop-relay"
STATE="${CONFIG_DIR}/watchdog.state"
LABEL_DAEMON="app.desktop-relay.daemon"
LABEL_TUNNEL="app.desktop-relay.tunnel"

[ -f "$CONFIG" ] || exit 0
read -r BASE EDGE_KIND < <(node -e "
  const c = JSON.parse(require('fs').readFileSync('$CONFIG','utf8'));
  const h = c.listenHost ?? '127.0.0.1', p = c.listenPort ?? 8788;
  console.log('http://'+h+':'+p, c.edge?.kind ?? 'none');
" 2>/dev/null) || exit 0

# Health-only credential: mint one with --tools '' and export it as DR_HEALTH_TOKEN
# in the watchdog plist environment. Without it the watchdog only checks the listener.
AUTH=(); [ -n "${DR_HEALTH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${DR_HEALTH_TOKEN}")

local_ok() {
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${AUTH[@]}" "${BASE}/healthz")
  [ "$code" = "200" ]
}

if ! local_ok; then
  echo "$(date -u +%FT%TZ) local check failed -> kickstart daemon" >> "${LOGDIR}/watchdog.log"
  launchctl kickstart -k "gui/$(id -u)/${LABEL_DAEMON}" 2>/dev/null
  exit 0
fi

# Public probe every ~15 runs (15 min), ngrok-quota-aware.
RUN=$(cat "$STATE" 2>/dev/null || echo 0); RUN=$((RUN+1)); echo "$RUN" > "$STATE"
[ $((RUN % 15)) -ne 0 ] && exit 0

PUBLIC=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).publicBaseUrl ?? '')" 2>/dev/null)
[ -z "$PUBLIC" ] && exit 0
[ "$EDGE_KIND" = "none" ] && exit 0

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${AUTH[@]}" "${PUBLIC}/healthz")
case "$code" in
  200) exit 0 ;;
  429)
    echo "$(date -u +%FT%TZ) public probe rate-limited (429) - provider quota, no restart" >> "${LOGDIR}/watchdog.log"
    ;;
  000|502|503|504)
    # Bounded recovery: max 4 tunnel restarts/hour.
    RESTARTS_FILE="${STATE}.restarts"; HOUR=$(date +%s); HOUR=$((HOUR/3600))
    R=$(grep -c "^${HOUR}$" "$RESTARTS_FILE" 2>/dev/null || echo 0)
    if [ "$R" -lt 4 ]; then
      echo "$HOUR" >> "$RESTARTS_FILE"
      echo "$(date -u +%FT%TZ) public unreachable ($code) -> kickstart tunnel ($((R+1))/4 this hour)" >> "${LOGDIR}/watchdog.log"
      launchctl kickstart -k "gui/$(id -u)/${LABEL_TUNNEL}" 2>/dev/null
    else
      echo "$(date -u +%FT%TZ) public unreachable ($code) - recovery budget exhausted" >> "${LOGDIR}/watchdog.log"
    fi
    ;;
  *)
    echo "$(date -u +%FT%TZ) public probe unexpected $code - no action" >> "${LOGDIR}/watchdog.log"
    ;;
esac
exit 0
