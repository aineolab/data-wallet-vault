#!/usr/bin/env python3
"""
Wallet vs live LinkedIn: the drift check.

Run AFTER eval/linkedin_flow.py has ingested the archive. With MOCK_LINKEDIN=1 the server's live source
is a mock of LinkedIn's Member Snapshot API that serves seed/out/linkedin/api_snapshot.json, which has
deliberate changes since the archive (a promotion, a new role, -Fastify +Rust, a new headline, +3 connections).

Calls  POST /v1/sources/linkedin/drift  (owner) -> {domains: {DOMAIN: {added, removed, changed, unchanged, ...}}, requested_domains: [...]}
and checks:
  1 every expected change is found, nothing extra is invented
  2 only allowlisted domains were requested from LinkedIn (never INBOX, LOGIN, security logs...)
  3 connections compared as counts only
  4 the drift check is read-only: wallet rows are unchanged until the owner calls /v1/sources/linkedin/apply-drift
  5 the call is in the ledger (operation LINKEDIN_DRIFT_CHECK)
"""
import json, os, sys, datetime, urllib.request
from pathlib import Path
try:
    import psycopg
except ImportError:
    sys.exit("pip install 'psycopg[binary]'")

ROOT = Path(__file__).resolve().parent.parent
KEY = json.loads((ROOT / "seed/out/linkedin/linkedin_key.json").read_text())["api_drift"]
URL = os.environ.get("WALLET_URL", "http://localhost:3000")
DB = os.environ.get("DATABASE_URL", "postgres://wallet:wallet@localhost:5433/wallet")
OWNER = os.environ.get("OWNER_TOKEN", "")

def call(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {OWNER}"} if OWNER else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

results = []
def check(name, ok, detail=""):
    results.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(detail)) if detail and not ok else ''}")

with psycopg.connect(DB) as conn:
    before = conn.execute("SELECT identity_card::text, work_history::text, social_graph_summary::text FROM canonical_profiles LIMIT 1").fetchone()
    n_mem_before = conn.execute("SELECT count(*) FROM canonical_memories").fetchone()[0]

    st, d = call("POST", "/v1/sources/linkedin/drift", {})
    if st != 200: sys.exit(f"drift call failed: {st} {d}")
    dom, exp = d.get("domains", {}), KEY["expect"]

    # 1 expected changes
    check("1 PROFILE headline changed", "Headline" in (dom.get("PROFILE", {}).get("changed") or []), dom.get("PROFILE"))
    pos = dom.get("POSITIONS", {})
    added_pos = {tuple(x) if isinstance(x, list) else (x.get("company"), x.get("title")) for x in pos.get("added", [])}
    check("1 POSITIONS new role found", {tuple(x) for x in exp["POSITIONS"]["added"]} <= added_pos, pos)
    changed_pos = json.dumps(pos.get("changed", []))
    check("1 POSITIONS promotion found", "Staff Backend Engineer" in changed_pos and "Senior Backend Engineer" in changed_pos, pos)
    sk = dom.get("SKILLS", {})
    check("1 SKILLS +Rust -Fastify", set(sk.get("added", [])) == set(exp["SKILLS"]["added"]) and set(sk.get("removed", [])) == set(exp["SKILLS"]["removed"]), sk)
    check("1 EDUCATION unchanged", not dom.get("EDUCATION", {}).get("added") and not dom.get("EDUCATION", {}).get("changed") and not dom.get("EDUCATION", {}).get("removed"), dom.get("EDUCATION"))

    # 2 allowlist
    req = set(d.get("requested_domains", []))
    check("2 only allowlisted domains requested", req and req <= set(KEY["allowlist"]), req)
    check("2 never requested inbox/security/login", not (req & set(KEY["never_request"])), req & set(KEY["never_request"]))

    # 3 connections as counts
    c = dom.get("CONNECTIONS", {})
    check("3 connections compared as counts", c.get("count_before") == exp["CONNECTIONS"]["count_before"] and c.get("count_after") == exp["CONNECTIONS"]["count_after"]
          and "added" not in c and "removed" not in c, c)

    # 4 read-only
    after = conn.execute("SELECT identity_card::text, work_history::text, social_graph_summary::text FROM canonical_profiles LIMIT 1").fetchone()
    n_mem_after = conn.execute("SELECT count(*) FROM canonical_memories").fetchone()[0]
    check("4 drift check did not modify the wallet", before == after and n_mem_before == n_mem_after)

    # 5 ledger
    n = conn.execute("SELECT count(*) FROM egress_ledger WHERE operation='LINKEDIN_DRIFT_CHECK'").fetchone()[0]
    check("5 drift check logged in ledger", n >= 1)

passed = sum(results)
line = f"{datetime.datetime.now().isoformat(timespec='seconds')}  linkedin_drift: {passed}/{len(results)} -> {'PASS' if passed == len(results) else 'FAIL'}"
print("\n" + line)
with open(ROOT / "eval/RESULTS.md", "a") as fh: fh.write(f"- {line}\n")
sys.exit(0 if passed == len(results) else 1)
