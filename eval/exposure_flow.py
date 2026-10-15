#!/usr/bin/env python3
"""
Exposure Finder + GDPR request flow, against the mock web (MOCK_WEB=1) and a mock clock.

Server endpoints (owner token only):
  POST /v1/exposure/scan                 {}                      -> {scan_id, exposures:[...], skipped:[{url, reason}], queries:[...]}
  POST /v1/exposure/scan  {subject:"…"}  any other name          -> 403 SUBJECT_NOT_OWNER
  POST /v1/exposure/{id}/confirm         {is_me: bool}
  POST /v1/privacy-requests              {exposure_id, kind}     -> {request_id, state:"DRAFTED", draft_subject, draft_body, due_days}
  POST /v1/privacy-requests/{id}/sent    {}                      (owner says "I sent it"; the wallet never sends email itself)
  POST /v1/privacy-requests/{id}/event   {type: ack|data_received|completed|refused}
  POST /v1/privacy-requests/tick         {now?: ISO}             (mock clock allowed only with MOCK_WEB=1)
  GET  /v1/privacy-requests/{id}

Cases:
  1 finds every real exposure with the expected risk and recommended action
  2 the namesake is surfaced as low confidence and not acted on until the owner confirms
  3 the employer-only news page is not matched
  4 the robots.txt-blocked site is skipped and reported, not fetched
  5 scans only use the owner's verified identifiers; scanning anyone else is refused
  6 consumer tokens cannot read exposures (scope-restricted)
  7 access request (Art. 15) then erasure (Art. 17) runs DRAFTED -> SENT -> ACKNOWLEDGED -> DATA_RECEIVED -> COMPLETED
  8 an ignored erasure request goes OVERDUE after 30 days, then ESCALATED with a drafted complaint
  9 drafts cite the right GDPR article, name the controller, and contain no data beyond what's needed to identify the owner
"""
import json, os, sys, datetime, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KEY = json.loads((ROOT / "seed/out/exposure/exposure_key.json").read_text())
URL = os.environ.get("WALLET_URL", "http://localhost:3000")
OWNER = os.environ.get("OWNER_TOKEN", "")
CONSUMER = os.environ.get("CONSUMER_TOKEN", "")   # a token scoped to coding_preferences

def call(method, path, body=None, token=OWNER):
    req = urllib.request.Request(URL + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

res = []
def check(name, ok, detail=""):
    res.append(ok); print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + str(detail)[:200]) if detail and not ok else ''}")

st, scan = call("POST", "/v1/exposure/scan", {})
if st != 200: sys.exit(f"scan failed {st} {scan}")
by_url = {e["url"]: e for e in scan.get("exposures", [])}

# 1
for url, exp in KEY["expect_exposures"].items():
    e = by_url.get(url)
    ok = e and e["risk"] == exp["risk"] and e["recommended_action"] == exp["action"] and set(exp["data_found_min"]) <= set(e.get("data_found", []))
    check(f"1 found {url.split('/')[2]} ({exp['risk']}, {exp['action']})", bool(ok), e)
# 2
ns = by_url.get(KEY["namesakes"][0])
check("2 namesake surfaced with low confidence", ns is not None and float(ns["match_confidence"]) < 0.5, ns)
check("2 namesake has no action until confirmed", ns is not None and ns["recommended_action"] in ("none", "monitor") and ns.get("owner_confirmed") is None, ns)
# 3
check("3 employer-only page not matched", KEY["must_not_match"][0] not in by_url)
# 4
skipped = {s["url"]: s["reason"] for s in scan.get("skipped", [])}
check("4 robots-blocked site skipped and reported", KEY["robots_blocked"][0] in skipped and "robots" in skipped[KEY["robots_blocked"][0]].lower() and KEY["robots_blocked"][0] not in by_url)
# 5
qs = " ".join(scan.get("queries", []))
check("5 queries use only owner identifiers", not any(n.lower() in qs.lower() for n in KEY["forbidden_queries_for"]), scan.get("queries"))
st, _ = call("POST", "/v1/exposure/scan", {"subject": "Priya Kaur"})
check("5 scanning someone else is refused", st == 403)
# 6
if CONSUMER:
    st, r = call("GET", "/v1/exposure", token=CONSUMER)
    check("6 consumer token cannot read exposures", st in (401, 403) or not r.get("exposures"))
else:
    check("6 consumer token cannot read exposures (set CONSUMER_TOKEN)", False, "CONSUMER_TOKEN not set")

# 7 access then erasure
broker = by_url[KEY["request_flow"]["access_then_erasure"]]
st, a = call("POST", "/v1/privacy-requests", {"exposure_id": broker["id"], "kind": "access_art15"})
seen = [a.get("state")]
for step in (("sent", None), ("event", "ack"), ("event", "data_received"), ("event", "completed")):
    path = f"/v1/privacy-requests/{a['request_id']}/{step[0]}"
    call("POST", path, {"type": step[1]} if step[1] else {})
    seen.append(call("GET", f"/v1/privacy-requests/{a['request_id']}")[1].get("state"))
check("7 access request lifecycle", seen == KEY["request_flow"]["happy_states"], seen)
st, er = call("POST", "/v1/privacy-requests", {"exposure_id": broker["id"], "kind": "erasure_art17"})
check("7 erasure request drafted after access", st == 200 and er.get("state") == "DRAFTED")

# 8 overdue
fp = by_url[KEY["request_flow"]["erasure_only"]]
st, r = call("POST", "/v1/privacy-requests", {"exposure_id": fp["id"], "kind": "erasure_art17"})
call("POST", f"/v1/privacy-requests/{r['request_id']}/sent", {})
future = (datetime.datetime.utcnow() + datetime.timedelta(days=KEY["request_flow"]["due_days"] + 1)).isoformat() + "Z"
call("POST", "/v1/privacy-requests/tick", {"now": future})
s1 = call("GET", f"/v1/privacy-requests/{r['request_id']}")[1].get("state")
call("POST", "/v1/privacy-requests/tick", {"now": future})
s2 = call("GET", f"/v1/privacy-requests/{r['request_id']}")[1]
check("8 ignored request goes OVERDUE", s1 in ("OVERDUE", "ESCALATED"), s1)
check("8 then ESCALATED with a complaint draft", s2.get("state") == "ESCALATED" and "complaint" in json.dumps(s2).lower(), s2.get("state"))

# 9 draft quality
body = (a.get("draft_body", "") + " " + er.get("draft_body", "") + " " + r.get("draft_body", "")).lower()
check("9 drafts cite Article 15 and Article 17", "article 15" in body and "article 17" in body)
check("9 drafts name the controller", "dataharbor" in body and "findpeoplenow" in body)
check("9 drafts don't over-share (no phone number, no relatives)", "07700" not in body and "sam w" not in body)

passed = sum(res)
line = f"{datetime.datetime.now().isoformat(timespec='seconds')}  exposure_flow: {passed}/{len(res)} -> {'PASS' if passed == len(res) else 'FAIL'}"
print("\n" + line)
with open(ROOT / "eval/RESULTS.md", "a") as fh: fh.write(f"- {line}\n")
sys.exit(0 if passed == len(res) else 1)
