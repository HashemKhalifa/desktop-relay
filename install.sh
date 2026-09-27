#!/usr/bin/env bash
# Local install only — public activation is a separate step (see README).
# Renders launchd plists, writes config.json, installs deps, bootstraps agents.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${HOME}/.config/desktop-relay"
CONFIG="${CONFIG_DIR}/config.json"
LOGDIR="${HOME}/Library/Logs/desktop-relay"
PLIST_DIR="${HOME}/Library/LaunchAgents"

EDGE="cloudflare"; DOMAIN=""; VPS_HOST=""; VPS_PORT="2222"; WITH_POWER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --edge) EDGE="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --vps) VPS_HOST="$2"; shift 2;;
    --vps-port) VPS_PORT="$2"; shift 2;;
    --power) WITH_POWER=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done

command -v node >/dev/null || { echo "node required (v24+)"; exit 1; }
NODE_BIN="$(command -v node)"
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 24 ] || { echo "node >= 24 required (found $(node -v))"; exit 1; }

UPSTREAM_ENTRY="$REPO/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"
command -v pnpm >/dev/null || { echo "pnpm required (see README)"; exit 1; }
(cd "$REPO" && pnpm install --frozen-lockfile)

mkdir -p "$CONFIG_DIR" "$LOGDIR" "$PLIST_DIR"
chmod 700 "$CONFIG_DIR"

case "$EDGE" in
  ngrok)
    [ -n "$DOMAIN" ] || { echo "--domain <your-static>.ngrok-free.app required for ngrok"; exit 1; }
    command -v ngrok >/dev/null || { echo "ngrok not installed"; exit 1; }
    PUBLIC_URL="https://${DOMAIN}"
    TUNNEL_ARGS="<string>$(command -v ngrok)</string><string>http</string><string>--url</string><string>${DOMAIN}</string><string>8788</string>"
    ;;
  cloudflare)
    [ -n "$DOMAIN" ] || { echo "--domain <hostname> required for cloudflare"; exit 1; }
    command -v cloudflared >/dev/null || { echo "cloudflared not installed"; exit 1; }
    echo "NOTE: cloudflare edge needs a named tunnel created beforehand:"
    echo "  cloudflared tunnel login && cloudflared tunnel create desktop-relay"
    echo "  cloudflared tunnel route dns desktop-relay ${DOMAIN}"
    PUBLIC_URL="https://${DOMAIN}"
    TUNNEL_ARGS="<string>$(command -v cloudflared)</string><string>tunnel</string><string>run</string>"
    ;;
  vps-ssh)
    [ -n "$VPS_HOST" ] || { echo "--vps user@host required for vps-ssh"; exit 1; }
    PUBLIC_URL="https://${DOMAIN:-$VPS_HOST}"
    TUNNEL_ARGS="<string>/usr/bin/ssh</string><string>-N</string><string>-T</string><string>-o</string><string>ServerAliveInterval=30</string><string>-o</string><string>ExitOnForwardFailure=yes</string><string>-R</string><string>127.0.0.1:${VPS_PORT}:127.0.0.1:8788</string><string>${VPS_HOST}</string>"
    echo "NOTE: vps-ssh requires server-side setup — see vps/README.md"
    ;;
  none) PUBLIC_URL=""; TUNNEL_ARGS="" ;;
  *) echo "unknown edge: $EDGE (ngrok|cloudflare|vps-ssh|none)"; exit 1;;
esac

EDGE_LINE="\"edge\": { \"kind\": \"$EDGE\" }"
[ -n "$DOMAIN" ] && EDGE_LINE="\"edge\": { \"kind\": \"$EDGE\", \"domain\": \"$DOMAIN\" }"
cat > "$CONFIG" <<EOF
{
  $EDGE_LINE,
  "publicBaseUrl": "$PUBLIC_URL",
  "listenHost": "127.0.0.1",
  "listenPort": 8788,
  "upstreamCmd": ["$NODE_BIN", "$UPSTREAM_ENTRY"],
  "upstreamCwd": "$HOME",
  "secretsPath": "$CONFIG_DIR/principals.json",
  "auditPath": "$CONFIG_DIR/audit.jsonl",
  "alertsPath": "$CONFIG_DIR/alerts.jsonl",
  "controlSockPath": "$CONFIG_DIR/control.sock",
  "rpcDeadlineMs": 900000,
  "uploadDeadlineMs": 10000,
  "maxBodyBytes": 16777216,
  "maxConcurrentPosts": 32,
  "maxSessions": 300,
  "logDir": "$LOGDIR"
}
EOF
chmod 600 "$CONFIG"

render() { # render <tmpl> <out> ; TUNNEL_ARGS is used inside the tunnel template
  sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@REPO@|$REPO|g" \
      -e "s|@LOGDIR@|$LOGDIR|g" -e "s|@CONFIG@|$CONFIG|g" \
      -e "s|@TUNNEL_ARGS@|${TUNNEL_ARGS:-<string>/bin/true</string>}|g" \
      "$REPO/launchd/$1" > "$PLIST_DIR/$2"
}
render app.desktop-relay.daemon.plist.tmpl   app.desktop-relay.daemon.plist
render app.desktop-relay.watchdog.plist.tmpl app.desktop-relay.watchdog.plist
[ "$EDGE" != "none" ] && render app.desktop-relay.tunnel.plist.tmpl app.desktop-relay.tunnel.plist
[ "$WITH_POWER" = 1 ] && render app.desktop-relay.power.plist.tmpl app.desktop-relay.power.plist

chmod +x "$REPO/bin/dc-relayctl" "$REPO/scripts/"*.sh 2>/dev/null || true

# principals.json must exist (0600) before first boot; mint happens after launch
# through the control socket.
[ -f "$CONFIG_DIR/principals.json" ] || { echo '{"version":1,"principals":[],"credentials":[]}' > "$CONFIG_DIR/principals.json"; chmod 600 "$CONFIG_DIR/principals.json"; }

uid="$(id -u)"
launchctl bootout "gui/$uid/app.desktop-relay.daemon"   2>/dev/null || true
launchctl bootout "gui/$uid/app.desktop-relay.tunnel"   2>/dev/null || true
launchctl bootout "gui/$uid/app.desktop-relay.watchdog" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$PLIST_DIR/app.desktop-relay.daemon.plist"
launchctl bootstrap "gui/$uid" "$PLIST_DIR/app.desktop-relay.watchdog.plist"
[ "$EDGE" != "none" ] && launchctl bootstrap "gui/$uid" "$PLIST_DIR/app.desktop-relay.tunnel.plist"
[ "$WITH_POWER" = 1 ] && launchctl bootstrap "gui/$uid" "$PLIST_DIR/app.desktop-relay.power.plist"

echo ""
echo "daemon installed. Next:"
echo "  dc-relayctl mint --name admin --kind bearer --tools all"
echo "  dc-relayctl url"
echo "  scripts/verify.sh"
[ -n "$PUBLIC_URL" ] && echo "  public endpoint: $PUBLIC_URL"
