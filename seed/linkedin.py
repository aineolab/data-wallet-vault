#!/usr/bin/env python3
"""
Builds a fake LinkedIn "Get a copy of your data" archive for the synthetic user Dana Whitfield,
plus an answer key. The mock LinkedIn provider in server/ serves this zip when a job becomes ready.

CSV names and columns follow LinkedIn's export format as commonly seen; verify against a real
export before claiming compatibility.

Outputs (seed/out/linkedin/):
  Basic_LinkedInDataExport_10-15-2026.zip
  linkedin_key.json
"""
import csv, io, json, random, zipfile, hashlib
from pathlib import Path

random.seed(20261016)
OUT = Path(__file__).parent / "out" / "linkedin"
OUT.mkdir(parents=True, exist_ok=True)

PROFILE = {"First Name": "Dana", "Last Name": "Whitfield", "Maiden Name": "", "Address": "", "Birth Date": "",
           "Headline": "Backend engineer at Parcelgrid · event-driven systems · TypeScript",
           "Summary": "I build logistics software that keeps parcels moving. Previously Northline Freight.",
           "Industry": "Software Development", "Zip Code": "", "Geo Location": "Leeds, England, United Kingdom",
           "Twitter Handles": "", "Websites": "", "Instant Messengers": ""}
POSITIONS = [
  {"Company Name": "Parcelgrid", "Title": "Senior Backend Engineer", "Description": "Lead a team of three on the route-optimisation service.", "Location": "Leeds", "Started On": "Mar 2023", "Finished On": ""},
  {"Company Name": "Northline Freight", "Title": "Backend Engineer", "Description": "Built shipment tracking APIs.", "Location": "Hull", "Started On": "Jan 2019", "Finished On": "Feb 2023"},
  {"Company Name": "Humber Digital", "Title": "Junior Developer", "Description": "Web apps for local businesses.", "Location": "Hull", "Started On": "Sep 2017", "Finished On": "Dec 2018"},
]
EDUCATION = [{"School Name": "University of York", "Start Date": "2014", "End Date": "2017", "Notes": "", "Degree Name": "BSc Computer Science", "Activities": "Hack society"}]
SKILLS = ["TypeScript", "Node.js", "PostgreSQL", "Event-driven architecture", "Distributed systems", "AWS", "Docker", "Fastify"]

FIRST = ["Alex","Sam","Priya","Tom","Aisha","Ben","Chloe","Dev","Elena","Femi","Grace","Hiro","Isla","Jonas","Kemi","Liam","Maya","Noah","Omar","Pia"]
LAST = ["Shaw","Patel","Okafor","Brennan","Lund","Haddad","Marino","Carter","Nair","Weber","Kaur","Doyle","Silva","Moreau","Ito","Byrne"]
COMPANIES = ["Parcelgrid","Northline Freight","Monzo","Sky","BJSS","Sage","Arm","Ocado","Deliveroo","ThoughtWorks"]
N_CONN = 120
connections = []
for i in range(N_CONN):
    f, l = random.choice(FIRST), random.choice(LAST)
    connections.append({"First Name": f, "Last Name": l, "URL": f"https://www.linkedin.com/in/{f.lower()}-{l.lower()}-{i:03d}",
                        "Email Address": "", "Company": random.choice(COMPANIES), "Position": random.choice(["Engineer","Product Manager","Designer","CTO","Recruiter"]),
                        "Connected On": f"{random.randint(1,28):02d} {random.choice(['Jan','Mar','Jun','Sep','Nov'])} {random.randint(2017,2026)}"})
# One message thread, which the wallet must NOT ingest by default (other people's words)
MESSAGES = [{"CONVERSATION ID": "msg_001", "FROM": "Alex Shaw", "TO": "Dana Whitfield", "DATE": "2026-09-01 10:00:00 UTC",
             "SUBJECT": "", "CONTENT": "Hey Dana, are you still thinking about that dev tools idea? My salary details are attached."}]

def to_csv(rows, preamble=None):
    buf = io.StringIO()
    if preamble: buf.write(preamble)
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
    return buf.getvalue()

zpath = OUT / "Basic_LinkedInDataExport_10-15-2026.zip"
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("Profile.csv", to_csv([PROFILE]))
    z.writestr("Positions.csv", to_csv(POSITIONS))
    z.writestr("Education.csv", to_csv(EDUCATION))
    z.writestr("Skills.csv", to_csv([{"Name": s} for s in SKILLS]))
    z.writestr("Connections.csv", to_csv(connections, preamble="Notes:\n\"When exporting your connection data, you may notice that some of the email addresses are missing.\"\n\n"))
    z.writestr("messages.csv", to_csv(MESSAGES))

key = {
  "archive": zpath.name,
  "sha256": hashlib.sha256(zpath.read_bytes()).hexdigest(),
  "expect_profile": {"full_name": "Dana Whitfield", "headline": PROFILE["Headline"], "location": PROFILE["Geo Location"]},
  "expect_positions": [{"company": p["Company Name"], "title": p["Title"]} for p in POSITIONS],
  "expect_skills": SKILLS,
  "expect_connections_count": N_CONN,
  # Privacy invariants: third parties' data must not be stored individually
  "forbidden_strings": sorted({c["URL"] for c in connections})[:20] + ["My salary details are attached"],
  "job_states_happy": ["REQUESTED", "AWAITING_ARCHIVE", "ARCHIVE_READY", "INGESTING", "AVAILABLE"],
  "job_states_terminal_fail": ["EXPIRED", "FAILED", "CANCELLED"],
}
# ---- Mock "live" LinkedIn Member Snapshot API (EEA/CH DMA API), with deliberate drift since the archive.
# Shape follows GET /rest/memberSnapshotData?q=criteria&domain=X (Linkedin-Version: 202312):
#   {"paging":{start,count,total,links}, "elements":[{"snapshotDomain": X, "snapshotData":[{...CSV-style keys...}]}]}
# snapshotData uses the same column names as the export CSVs, so ONE parser handles archive and API.
live_positions = [dict(p) for p in POSITIONS]
live_positions[0]["Title"] = "Staff Backend Engineer"                       # DRIFT: promotion
live_positions.insert(0, {"Company Name": "Parcelgrid", "Title": "Engineering Manager (acting)", "Description": "Covering parental leave.",
                          "Location": "Leeds", "Started On": "Oct 2026", "Finished On": ""})   # DRIFT: new role
live_skills = [s for s in SKILLS if s != "Fastify"] + ["Rust"]               # DRIFT: -Fastify +Rust
live_profile = dict(PROFILE); live_profile["Headline"] = "Staff engineer at Parcelgrid · event-driven systems · TypeScript & Rust"  # DRIFT
live_connections = connections + connections[:3]                              # DRIFT: +3 (count 123)
api = {
  "PROFILE": [live_profile],
  "POSITIONS": live_positions,
  "EDUCATION": EDUCATION,
  "SKILLS": [{"Name": s} for s in live_skills],
  "CONNECTIONS": live_connections,
  "INBOX": MESSAGES,                      # must never be requested (not in the allowlist)
  "SECURITY_CHALLENGE_PIPE": [{"Date": "2026-10-01", "IP Address": "203.0.113.7", "Country": "ES"}],   # must never be requested
}
(OUT / "api_snapshot.json").write_text(json.dumps(api, indent=1))
key["api_drift"] = {
  "allowlist": ["PROFILE", "POSITIONS", "EDUCATION", "SKILLS", "CONNECTIONS"],
  "never_request": ["INBOX", "SECURITY_CHALLENGE_PIPE", "LOGIN", "PHONE_NUMBERS", "EMAIL_ADDRESSES", "IDENTITY_CREDENTIALS_AND_ASSETS", "PREMIUM_NOTES"],
  "expect": {
    "PROFILE": {"changed": ["Headline"]},
    "POSITIONS": {"added": [["Parcelgrid", "Engineering Manager (acting)"]], "changed": [["Parcelgrid", "Senior Backend Engineer", "Staff Backend Engineer"]], "removed": []},
    "EDUCATION": {"unchanged": True},
    "SKILLS": {"added": ["Rust"], "removed": ["Fastify"]},
    "CONNECTIONS": {"count_before": N_CONN, "count_after": N_CONN + 3},
  },
}
(OUT / "linkedin_key.json").write_text(json.dumps(key, indent=1))
print(f"linkedin archive {zpath.name} sha={key['sha256'][:12]} positions={len(POSITIONS)} skills={len(SKILLS)} connections={N_CONN}")
