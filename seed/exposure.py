#!/usr/bin/env python3
"""
A fake little web for the Exposure Finder demo and tests. Every site is fictional (.example domains,
RFC 2606), and every person is fictional. The mock search provider (MOCK_WEB=1) answers queries from this
index instead of calling Tavily or Exa.

The index deliberately contains:
  - real hits on Dana Whitfield (people-search site, data broker, old forum post, breach notice, company page)
  - a NAMESAKE (a different Dana Whitfield, a dentist in Bristol) that must be flagged as "probably not you"
  - a page about someone else entirely that mentions Dana's employer, which must not be matched
  - a site whose robots.txt disallows crawling, which must be skipped

Outputs (seed/out/exposure/): web_index.json, exposure_key.json
"""
import json
from pathlib import Path

OUT = Path(__file__).parent / "out" / "exposure"
OUT.mkdir(parents=True, exist_ok=True)

OWNER_IDS = [
  {"kind": "full_name", "value": "Dana Whitfield"},
  {"kind": "email", "value": "dana.whitfield@mail.example"},
  {"kind": "city", "value": "Leeds"},
  {"kind": "employer", "value": "Parcelgrid"},
  {"kind": "username", "value": "dwhitfield_dev"},
]

PAGES = [
  {"url": "https://findpeoplenow.example/p/dana-whitfield-leeds", "site": "FindPeopleNow", "site_type": "people_search", "robots_allowed": True,
   "text": "Dana Whitfield, age 30-34, Leeds, West Yorkshire. Possible relatives: Sam W. Phone: 07700 900123. Email: dana.whitfield@mail.example",
   "privacy_contact": "privacy@findpeoplenow.example", "opt_out_form": "https://findpeoplenow.example/optout"},
  {"url": "https://dataharbor.example/profiles/8841-dana-whitfield", "site": "DataHarbor Marketing Ltd", "site_type": "data_broker", "robots_allowed": True,
   "text": "Consumer profile: Dana Whitfield, Leeds. Interests: cycling, coffee, home office. Employer: Parcelgrid. Segment: Tech professional 25-34.",
   "privacy_contact": "dpo@dataharbor.example", "opt_out_form": None},
  {"url": "https://forum.nodecraft.example/t/fastify-vs-express/1932#post-7", "site": "Nodecraft Forum", "site_type": "forum", "robots_allowed": True,
   "text": "dwhitfield_dev wrote: we moved our Leeds team at Parcelgrid to Fastify last year. DM me at dana.whitfield@mail.example",
   "privacy_contact": "admin@nodecraft.example", "opt_out_form": None},
  {"url": "https://breachwatch.example/incidents/2025-shopsmart", "site": "BreachWatch", "site_type": "breach_notice", "robots_allowed": True,
   "text": "ShopSmart 2025 breach: exposed email addresses including dana.whitfield@mail.example, hashed passwords, postcodes.",
   "privacy_contact": None, "opt_out_form": None},
  {"url": "https://parcelgrid.example/team", "site": "Parcelgrid", "site_type": "company_site", "robots_allowed": True,
   "text": "Our team: Dana Whitfield, Senior Backend Engineer, leads route optimisation.",
   "privacy_contact": "privacy@parcelgrid.example", "opt_out_form": None},
  # Namesake: same name, different person
  {"url": "https://bristolsmiles.example/our-dentists", "site": "Bristol Smiles Dental", "site_type": "company_site", "robots_allowed": True,
   "text": "Dr Dana Whitfield BDS, Bristol. Special interest in paediatric dentistry.",
   "privacy_contact": "info@bristolsmiles.example", "opt_out_form": None},
  # Mentions the employer only, about someone else
  {"url": "https://techleeds.example/news/parcelgrid-raises", "site": "TechLeeds News", "site_type": "news", "robots_allowed": True,
   "text": "Parcelgrid, the Leeds logistics software company, raised a Series A led by its CEO Priya Kaur.",
   "privacy_contact": None, "opt_out_form": None},
  # robots.txt disallows crawling: must be skipped and listed as "couldn't check"
  {"url": "https://closedbook.example/people/dana-whitfield", "site": "ClosedBook", "site_type": "people_search", "robots_allowed": False,
   "text": "Dana Whitfield, Leeds. Full report available.",
   "privacy_contact": "privacy@closedbook.example", "opt_out_form": "https://closedbook.example/remove"},
]

KEY = {
  "owner_identifiers": OWNER_IDS,
  "expect_exposures": {
    "https://findpeoplenow.example/p/dana-whitfield-leeds": {"risk": "high", "action": "erasure_request", "data_found_min": ["full_name", "city", "phone", "email"]},
    "https://dataharbor.example/profiles/8841-dana-whitfield": {"risk": "high", "action": "access_request", "data_found_min": ["full_name", "city", "employer"]},
    "https://forum.nodecraft.example/t/fastify-vs-express/1932#post-7": {"risk": "medium", "action": "erasure_request", "data_found_min": ["username", "email"]},
    "https://breachwatch.example/incidents/2025-shopsmart": {"risk": "high", "action": "monitor", "data_found_min": ["email"]},
    "https://parcelgrid.example/team": {"risk": "low", "action": "none", "data_found_min": ["full_name", "employer"]},
  },
  "namesakes": ["https://bristolsmiles.example/our-dentists"],          # must be found but marked low confidence, never auto-acted on
  "must_not_match": ["https://techleeds.example/news/parcelgrid-raises"],
  "robots_blocked": ["https://closedbook.example/people/dana-whitfield"],  # must be skipped and reported, not fetched
  "forbidden_queries_for": ["Sam Whitfield", "Priya Kaur", "Dr Dana Whitfield Bristol"],  # never search other people
  "request_flow": {
    "access_then_erasure": "https://dataharbor.example/profiles/8841-dana-whitfield",
    "erasure_only": "https://findpeoplenow.example/p/dana-whitfield-leeds",
    "happy_states": ["DRAFTED", "SENT", "ACKNOWLEDGED", "DATA_RECEIVED", "COMPLETED"],
    "overdue_states": ["DRAFTED", "SENT", "OVERDUE", "ESCALATED"],
    "due_days": 30,
  },
}

(OUT / "web_index.json").write_text(json.dumps({"pages": PAGES}, indent=1))
(OUT / "exposure_key.json").write_text(json.dumps(KEY, indent=1))
print(f"mock web: {len(PAGES)} pages, {len(KEY['expect_exposures'])} real exposures, 1 namesake, 1 robots-blocked")
