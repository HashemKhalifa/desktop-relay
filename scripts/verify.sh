#!/usr/bin/env bash
# Local acceptance: proves auth boundary + two clients sharing one child.
# Usage: scripts/verify.sh [base-url]   (default http://127.0.0.1:8788)
# Reads a bearer credential from the daemon's credential store via dc-relayctl.
set -u
BASE="${1:-http://127.0.0.1:8788}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }
check(){ [ "$2" = "$3" ] && ok "$1" || { bad "$1 (got '$2', want '$3')"; }; }

MCP_HEADERS=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')

echo "== auth boundary =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -d '{}')
check "POST /mcp without credentials -> 404" "$code" "404"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'authorization: Bearer wrong' -d '{}')
check "POST /mcp wrong bearer -> 404" "$code" "404"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'host: evil.example.com' -d '{}')
check "bad Host -> 403" "$code" "403"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'origin: https://evil.example.com' -d '{}')
check "bad Origin -> 403" "$code" "403"

# Need a real credential for the rest. mint a scratch principal, revoke at the end.
MINT=$("$REPO/bin/dc-relayctl" mint --name verify-scratch --kind bearer --tools all 2>/dev/null) \
  || { echo "FATAL: cannot mint scratch principal (daemon up?)"; exit 1; }
TOKEN=$(echo "$MINT" | sed -n 's/.*"secret": *"\([^"]*\)".*/\1/p')
PID_=$(echo "$MINT" | sed -n 's/.*"principalId": *"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "FATAL: mint returned no secret"; exit 1; }

cleanup() { "$REPO/bin/dc-relayctl" revoke --principal-id "$PID_" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== session A: initialize + tools/list + start_process =="
INIT=$(curl -s -D - -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify-A","version":"0"}}}')
SIDA=$(echo "$INIT" | sed -n 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii]d: *\([^[:space:]]*\).*/\1/p' | tr -d '\r')
[ -n "$SIDA" ] && ok "session A id" || bad "session A id missing"
echo "$INIT" | grep -q '"serverInfo"' && ok "initialize result" || bad "initialize result"

curl -s -o /dev/null -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDA" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

LISTA=$(curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDA" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "$LISTA" | grep -q 'start_process' && ok "tools/list contains start_process" || bad "tools/list missing start_process"
echo "$LISTA" | grep -q 'set_config_value' && bad "DENY_REMOTE leaked into tools/list" || ok "set_config_value absent from list"

START=$(curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDA" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"start_process","arguments":{"command":"echo relay-shared-child && sleep 30","timeout_ms":2000}}}')
echo "$START" | grep -q '"result"' && ok "A: start_process dispatched" || bad "A: start_process failed: $(echo "$START" | head -c 200)"

echo "== session B: second client, same child =="
INITB=$(curl -s -D - -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify-B","version":"0"}}}')
SIDB=$(echo "$INITB" | sed -n 's/^[Mm][Cc][Pp]-[Ss]ession-[Ii]d: *\([^[:space:]]*\).*/\1/p' | tr -d '\r')
[ -n "$SIDB" ] && [ "$SIDB" != "$SIDA" ] && ok "session B id distinct" || bad "session B id"
curl -s -o /dev/null -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDB" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

PROCS=$(curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDB" \
  -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_processes","arguments":{}}}')
echo "$PROCS" | grep -q 'sleep 30' && ok "B sees A's process (shared child)" || bad "B cannot see A's process: $(echo "$PROCS" | head -c 200)"

echo "== policy + method surface =="
DENY=$(curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDB" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"set_config_value","arguments":{"key":"x","value":1}}}')
echo "$DENY" | grep -q '"error"' && ok "set_config_value denied" || bad "set_config_value not denied: $(echo "$DENY" | head -c 200)"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/mcp" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDB")
check "GET /mcp -> 405" "$code" "405"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz" -H "authorization: Bearer $TOKEN")
check "healthz authed -> 200" "$code" "200"

echo "== revoke closes sessions =="
"$REPO/bin/dc-relayctl" revoke --principal-id "$PID_" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" -H "authorization: Bearer $TOKEN" -H "mcp-session-id: $SIDA" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}')
check "post-revoke request -> 404" "$code" "404"

echo ""
echo "verify: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
