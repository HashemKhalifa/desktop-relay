# vps-ssh edge (optional)

Self-sovereign edge: `ssh -R` from the Mac into your existing VPS; Caddy serves TLS.
Credential enforcement lives **only** in the Mac daemon — the VPS never sees secrets.

- `Caddyfile.tmpl` — TLS + reverse proxy to the forwarded loopback port.
- `sshd-dcrelay.conf` — drop-in for a forward-only account: `PermitListen` pins the
  remote bind to loopback (OpenSSH 7.8+; `PermitOpen` is not a substitute), shell and
  other forwardings off.
- `../scripts/vps-bootstrap.sh` — server-side setup run once as root/sudo.

Mac side: `install.sh --edge vps-ssh --vps <user>@<host> --domain <public-host>` runs
the tunnel as `ssh -N -T -R 127.0.0.1:2222:127.0.0.1:8788 <host>` under launchd.
