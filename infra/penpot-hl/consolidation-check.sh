#!/usr/bin/env bash
# Consolidation verification: asserts the single "real" instance (penpot-hl :9101)
# is the consolidated one carrying our changes, the old :9001 is gone, the design
# system is imported, and the shortcut/MCP are repointed. Exit non-zero on any failure.
set -uo pipefail

BASE="http://localhost:9101"
OLD="http://localhost:9001"
SRC="/mnt/data/src/penpot"
ENV_FILE="$SRC/infra/penpot-hl/test-env.json"
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

fails=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; fails=$((fails+1)); }
chk()  { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "Consolidation check → real instance $BASE"

# 1. old :9001 instance is gone (no container, no volumes, not serving)
chk "old :9001 not serving"            '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 4 '"$OLD"' 2>/dev/null)" = "000" ]'
chk "no penpot_penpot_* volumes left"  '! '"$DOCKER"' volume ls --format "{{.Name}}" | grep -q "^penpot_penpot_"'
chk "no penpot-penpot-* containers"    '! '"$DOCKER"' ps -a --format "{{.Names}}" | grep -q "^penpot-penpot-"'

# 2. :9101 is up and is the consolidated instance with our changes
chk ":9101 app serving (200)"          '[ "$(curl -s -o /dev/null -w %{http_code} '"$BASE"')" = "200" ]'
chk ":9101 mcp = penpot-mcp:local"     '[ "$('"$DOCKER"' inspect penpot-hl-penpot-mcp-1 --format "{{.Config.Image}}")" = "penpot-mcp:local" ]'
chk ":9101 serves upgraded plugin"     '[ "$(curl -s '"$BASE"'/plugins/mcp/plugin.js | wc -c)" -gt 9000 ]'
chk ":9101 /mcp/stream initializes"    '[ "$(curl -s -o /dev/null -w %{http_code} -X POST '"$BASE"'/mcp/stream -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '"'"'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}'"'"')" = "200" ]'

# 3. design system imported
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).token)' "$ENV_FILE")
  PID=0398e5fc-95c9-80d6-8008-29071f130e36
  FILES=$(curl -s -X GET "$BASE/api/rpc/command/get-project-files?project-id=$PID" -H "Authorization: Token $TOKEN" -H 'Accept: application/json')
  chk "Default Design System imported" 'echo '"'"''"$FILES"''"'"' | grep -q "Default Design System"'
else
  bad "test-env.json present (for design-system check)"
fi

# 4. shortcut + MCP repointed to :9101
chk "penpot control script -> :9101"   '[ "$('"$HOME"'/.local/bin/penpot url 2>/dev/null)" = "'"$BASE"'" ]'
chk "Claude penpot MCP -> :9101"       'claude mcp list 2>/dev/null | grep -E "^penpot:" | grep -q "localhost:9101"'
chk "Claude penpot-headless present"   'claude mcp list 2>/dev/null | grep -q "^penpot-headless:"'
chk "backup of :9001 exists"           'ls '"$HOME"'/penpot-backups/penpot9001-*.tgz >/dev/null 2>&1'

echo
if [ "$fails" -eq 0 ]; then echo "PASS — consolidation verified (single instance :9101)"; else echo "FAIL — $fails check(s) failed"; fi
exit $((fails > 0 ? 1 : 0))
