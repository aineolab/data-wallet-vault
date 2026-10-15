#!/usr/bin/env bash
# Data Wallet demo: mint an owner token + a coding-only consumer token, register both in Claude Code, print the demo prompts.
# Run on the Mac:  bash scripts/demo-connect.sh
set -euo pipefail
URL="${WALLET_URL:-https://data-wallet-server-nyolab.vercel.app}"
OUT="server/.tokens"; umask 077
mint() { curl -sS "$URL/v1/tokens/issue" -H 'content-type: application/json' -d "$1" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("token") or sys.exit("mint failed: "+json.dumps(d)))'; }
OWNER=$(mint '{"consumer_name":"Tim — Claude Code (owner)","consumer_type":"OWNER","scopes":["work_profile","coding_preferences","shopping_preferences","personal_memory"]}')
CONSUMER=$(mint '{"consumer_name":"Second agent (coding only)","consumer_type":"AI_AGENT_MCP","scopes":["coding_preferences"]}')
printf 'OWNER_TOKEN=%s\nCONSUMER_TOKEN=%s\n' "$OWNER" "$CONSUMER" > "$OUT"
echo "tokens written to $OUT (chmod 600). Never paste them into chat."
claude mcp remove wallet-owner >/dev/null 2>&1 || true
claude mcp remove wallet-coding >/dev/null 2>&1 || true
claude mcp add --transport http wallet-owner  "$URL/mcp" --header "Authorization: Bearer $OWNER"
claude mcp add --transport http wallet-coding "$URL/mcp" --header "Authorization: Bearer $CONSUMER"
echo
echo "Registered two MCP servers in Claude Code: wallet-owner (12 tools) and wallet-coding (2 read-only tools)."
echo "Dashboard: open https://data-wallet-vault.lovable.app → Settings → paste the OWNER token from $OUT."
echo
echo "DEMO (two terminals, both: claude):"
echo " Owner terminal  0. 'Get my LinkedIn data into my wallet.'   (job runs ~2 min while you talk)"
echo " Owner terminal  1. 'Is my LinkedIn import done? What did it find?'"
echo " Coding terminal 2. 'Using the wallet, what stack should I use for my next project?'"
echo " Coding terminal 3. 'What is my mortgage situation?'          -> SCOPE_RESTRICTED"
echo " Owner terminal  4. 'Who read my wallet today? Revoke the second agent.'  then repeat 2 -> WALLET_ACCESS_REVOKED"
echo " Owner terminal  5. 'Ship my shopping data to Acme, exclusive.' then 'Offer it to Globex' -> RESALE_BLOCKED"
echo "Tip: the coding terminal only sees wallet-coding if you start it in a folder where wallet-owner isn't configured,"
echo "     or tell it: 'Only use the wallet-coding server.'"
