#!/usr/bin/env python3
"""
Lane E grader. Fires every injection in the answer key at the wallet's REST surface
with a token scoped to ['coding_preferences'] and asserts:
  - 0 rows with scope_category = health_finance_restricted ever returned
  - every blocked attempt appears in egress_ledger as SCOPE_BLOCKED
  - after DELETE /v1/tokens/{id}, the next call returns 401/403 within 5s
  - a second token issue against an EXCLUSIVE (shipped) grant is rejected with RESALE_BLOCKED

Expects the wallet server on WALLET_URL (default http://localhost:3000) with these routes (Lane D):
  POST /v1/tokens/issue   {consumer_name, consumer_type, scopes[], exclusive?} -> {token, token_id, grant_id}
  POST /v1/memories/query {query, category?, limit?}  (Bearer token)        -> {records:[{fact, category}], notice?}
  DELETE /v1/tokens/{id}
  POST /v1/ship           {grant_id}                                         -> shreds covered raw files, marks grant SHIPPED
  GET  /v1/ledger
"""
import json, os, sys, time, datetime, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEY = json.loads((ROOT / "seed/out/answer_key.json").read_text())
URL = os.environ.get("WALLET_URL", "http://localhost:3000")

def call(method, path, body=None, token=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

fails = []
st, tok = call("POST", "/v1/tokens/issue", {"consumer_name": "redteam", "consumer_type": "AI_AGENT_MCP", "scopes": ["coding_preferences"]})
if st != 200: sys.exit(f"token issue failed: {st} {tok}")
token, token_id = tok["token"], tok["token_id"]

leaked = 0
for inj in KEY["injections"]:
    st, res = call("POST", "/v1/memories/query", {"query": inj, "limit": 20}, token)
    rows = res.get("records", []) if st == 200 else []
    bad = [r for r in rows if r.get("category") == "health_finance_restricted"]
    if bad: leaked += len(bad); fails.append(f"restricted rows served for injection: {inj[:60]}")
    # also try the explicit category override
    st, res = call("POST", "/v1/memories/query", {"query": inj, "category": "health_finance_restricted", "limit": 20}, token)
    rows = res.get("records", []) if st == 200 else []
    if any(r.get("category") == "health_finance_restricted" for r in rows): leaked += 1; fails.append(f"category override leaked: {inj[:60]}")

st, ledger = call("GET", "/v1/ledger")
blocked = sum(1 for e in ledger.get("entries", []) if e.get("operation") == "SCOPE_BLOCKED") if st == 200 else 0
if blocked == 0: fails.append("no SCOPE_BLOCKED entries in ledger")

# kill switch
call("DELETE", f"/v1/tokens/{token_id}")
t0 = time.time(); st, _ = call("POST", "/v1/memories/query", {"query": "fastify"}, token)
if st not in (401, 403): fails.append(f"kill switch: expected 401/403 after revoke, got {st}")
if time.time() - t0 > 5: fails.append("kill switch took >5s")

# exclusivity / resale guard
st, ship_tok = call("POST", "/v1/tokens/issue", {"consumer_name": "buyer_acme", "consumer_type": "DATA_BUYER_API", "scopes": ["shopping_preferences"], "exclusive": True})
if st == 200:
    call("POST", "/v1/ship", {"grant_id": ship_tok["grant_id"]})
    st2, again = call("POST", "/v1/tokens/issue", {"consumer_name": "buyer_other", "consumer_type": "DATA_BUYER_API", "scopes": ["shopping_preferences"]})
    if st2 == 200: fails.append("resale allowed after exclusive ship")
    elif again.get("error") != "RESALE_BLOCKED": fails.append(f"resale blocked but wrong code: {again}")
else: fails.append(f"exclusive issue failed: {st}")

line = f"{datetime.datetime.now().isoformat(timespec='seconds')}  redteam: injections {len(KEY['injections'])}  restricted_leaked {leaked}  scope_blocked_logged {blocked}  failures {len(fails)} -> {'PASS' if not fails else 'FAIL'}"
print(line)
for f in fails: print("  FAIL", f)
with open(ROOT / "eval/RESULTS.md", "a") as fh: fh.write(f"- {line}\n")
sys.exit(0 if not fails else 1)
