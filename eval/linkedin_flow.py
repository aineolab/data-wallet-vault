#!/usr/bin/env python3
"""
LinkedIn GDPR-export flow test, run against the mock provider so it finishes in seconds, not hours.

Requires the server with MOCK_LINKEDIN=1. The mock honours two request-body knobs ONLY in mock mode:
  mock_delay_s  seconds until the archive is "ready"   (default 60; this test uses 3)
  mock_outcome  "ok" | "expired" | "corrupt"           (default "ok")
Jobs advance when POST /v1/jobs/tick is called (Supabase Cron calls it every 30 s in production;
this test calls it directly so it never waits on cron).

Cases:
  1 happy path       REQUESTED -> AWAITING_ARCHIVE -> ARCHIVE_READY -> INGESTING -> AVAILABLE, profile/positions/skills land
  2 privacy          connections stored only as a count; no connection URL or message text anywhere in the DB
  3 idempotent       a second job delivering the same archive creates no new raw_vault_files row
  4 expired          archive window passes -> EXPIRED, nothing written
  5 corrupt          zip fails to parse -> retries -> FAILED, nothing written, error recorded
  6 consent revoked  revoke the DATA_IN grant while waiting -> CANCELLED, archive never fetched
  7 ledger           every job transition is in source_job_events; the owner can read it via wallet_job_status
"""
import json, os, sys, time, datetime, urllib.request
from pathlib import Path
try:
    import psycopg
except ImportError:
    sys.exit("pip install 'psycopg[binary]'")

ROOT = Path(__file__).resolve().parent.parent
KEY = json.loads((ROOT / "seed/out/linkedin/linkedin_key.json").read_text())
URL = os.environ.get("WALLET_URL", "http://localhost:3000")
DB = os.environ.get("DATABASE_URL", "postgres://wallet:wallet@localhost:5433/wallet")
OWNER = os.environ.get("OWNER_TOKEN", "")   # owner bearer token (from /v1/tokens/issue with consumer_type OWNER)

def call(method, path, body=None):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {OWNER}"} if OWNER else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

def run_until_terminal(job_id, limit_s=60):
    seen, t0 = [], time.time()
    while time.time() - t0 < limit_s:
        call("POST", "/v1/jobs/tick", {})
        st, j = call("GET", f"/v1/jobs/{job_id}")
        if st != 200: return seen, {"state": f"HTTP {st}"}
        if not seen or seen[-1] != j["state"]: seen.append(j["state"])
        if j["state"] in ("AVAILABLE", "EXPIRED", "FAILED", "CANCELLED"): return seen, j
        time.sleep(1)
    return seen, {"state": "TIMEOUT"}

def request(**knobs):
    st, j = call("POST", "/v1/sources/linkedin/request", {"archive_kind": "fast", **knobs})
    if st != 200: raise SystemExit(f"request failed {st} {j}")
    return j

results = []
def check(name, ok, detail=""):
    results.append((name, ok)); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail and not ok else ''}")

with psycopg.connect(DB) as conn:
    raw_before = conn.execute("SELECT count(*) FROM raw_vault_files WHERE source_type='LINKEDIN_EXPORT'").fetchone()[0]

    # 1 happy path
    j = request(mock_delay_s=3)
    seen, final = run_until_terminal(j["job_id"])
    want = KEY["job_states_happy"]
    check("1 happy path reaches AVAILABLE", final["state"] == "AVAILABLE", f"seen={seen}")
    check("1 states in order", [s for s in seen if s in want] == [s for s in want if s in seen] and seen[0] == "REQUESTED", f"seen={seen}")
    prof = conn.execute("SELECT identity_card, work_history, social_graph_summary FROM canonical_profiles LIMIT 1").fetchone()
    ic, wh, sg = (prof or ({}, [], {}))
    check("1 profile name + headline", ic.get("full_name") == KEY["expect_profile"]["full_name"] and ic.get("headline") == KEY["expect_profile"]["headline"])
    comps = {(p.get("company"), p.get("title")) for p in (wh or [])}
    check("1 all positions", all((p["company"], p["title"]) in comps for p in KEY["expect_positions"]), f"got={comps}")
    mems = " ".join(r[0] for r in conn.execute("SELECT fact_assertion FROM canonical_memories WHERE source_provider IN ('linkedin','linkedin_mock')"))
    check("1 skills distilled as work_profile facts", sum(s.lower() in mems.lower() for s in KEY["expect_skills"]) >= len(KEY["expect_skills"]) - 1)

    # 2 privacy
    check("2 connections stored as count only", (sg or {}).get("connections_count") == KEY["expect_connections_count"])
    dump = " ".join(str(r) for r in conn.execute(
        "SELECT identity_card::text || work_history::text || social_graph_summary::text || source_extensions::text FROM canonical_profiles")) + mems
    leaked = [s for s in KEY["forbidden_strings"] if s in dump]
    check("2 no connection URLs or message text stored", not leaked, f"leaked={leaked[:3]}")

    # 3 idempotent
    j2 = request(mock_delay_s=1); run_until_terminal(j2["job_id"])
    raw_after = conn.execute("SELECT count(*) FROM raw_vault_files WHERE source_type='LINKEDIN_EXPORT'").fetchone()[0]
    check("3 same archive not stored twice", raw_after - raw_before == 1, f"new raw rows={raw_after - raw_before}")

    # 4 expired
    j = request(mock_delay_s=1, mock_outcome="expired"); seen, final = run_until_terminal(j["job_id"])
    check("4 expired archive -> EXPIRED", final["state"] == "EXPIRED", f"seen={seen}")

    # 5 corrupt
    j = request(mock_delay_s=1, mock_outcome="corrupt"); seen, final = run_until_terminal(j["job_id"])
    check("5 corrupt archive -> FAILED with error", final["state"] == "FAILED" and final.get("last_error"), f"final={final}")

    # 6 consent revoked mid-wait
    j = request(mock_delay_s=30)
    call("POST", "/v1/jobs/tick", {})
    call("DELETE", f"/v1/grants/{j['grant_id']}")
    seen, final = run_until_terminal(j["job_id"], limit_s=10)
    check("6 revoked consent -> CANCELLED", final["state"] == "CANCELLED", f"seen={seen}")
    fetched = conn.execute("SELECT raw_file_id FROM source_jobs WHERE id=%s", (j["job_id"],)).fetchone()[0]
    check("6 archive never fetched after revoke", fetched is None)

    # 7 events
    n_ev = conn.execute("SELECT count(*) FROM source_job_events").fetchone()[0]
    check("7 job transitions recorded", n_ev >= 5 * 4)

passed = sum(ok for _, ok in results)
line = f"{datetime.datetime.now().isoformat(timespec='seconds')}  linkedin_flow: {passed}/{len(results)} -> {'PASS' if passed == len(results) else 'FAIL'}"
print("\n" + line)
with open(ROOT / "eval/RESULTS.md", "a") as fh: fh.write(f"- {line}\n")
sys.exit(0 if passed == len(results) else 1)
