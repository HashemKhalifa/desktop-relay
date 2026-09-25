#!/usr/bin/env bash
# Removes launchd agents + (with --purge) the config dir. Keeps credentials and
# audit logs by default — reinstall preserves them.
set -euo pipefail
PURGE=0; [ "${1:-}" = "--purge" ] && PURGE=1
uid="$(id -u)"
for label in daemon tunnel watchdog power; do
  launchctl bootout "gui/$uid/app.desktop-relay.$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/app.desktop-relay.$label.plist"
done
if [ "$PURGE" = 1 ]; then
  rm -rf "$HOME/.config/desktop-relay" "$HOME/Library/Logs/desktop-relay"
  echo "purged config dir, credentials, and logs"
else
  echo "agents removed; kept $HOME/.config/desktop-relay (credentials, audit)"
fi
