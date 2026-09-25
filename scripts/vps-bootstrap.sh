#!/usr/bin/env bash
# One-time VPS-side setup for the vps-ssh edge. Run on the VPS as root or via sudo.
# Usage: vps-bootstrap.sh <domain> [port] [ssh-user]
set -euo pipefail
DOMAIN="${1:?domain required}"; PORT="${2:-2222}"; USER_="${3:-dcrelay}"

id "$USER_" 2>/dev/null || useradd -m -s /bin/false "$USER_"
mkdir -p "/home/$USER_/.ssh"
echo ">> put the Mac's public key in /home/$USER_/.ssh/authorized_keys"

install -m 644 "$(dirname "$0")/../vps/sshd-dcrelay.conf" /etc/ssh/sshd_config.d/dcrelay.conf
sed "s/@DOMAIN@/$DOMAIN/g; s/@PORT@/$PORT/g" "$(dirname "$0")/../vps/Caddyfile.tmpl" > /etc/caddy/Caddyfile

sshd -t && systemctl reload sshd
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
echo "done. Test: ssh -N -R 127.0.0.1:$PORT:127.0.0.1:8788 $USER_@$(hostname -f 2>/dev/null || echo this-host)"
