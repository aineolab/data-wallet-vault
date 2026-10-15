# Data Wallet

**An open-source, self-hostable wallet for your personal data that lives inside your AI agents.**

Connect it to Claude (and other MCP clients) as a connector. Deposit your data, from ChatGPT/Claude exports or your
LinkedIn data archive, and it is scrubbed of secrets and distilled into facts with provenance. Any AI you connect reads only the
categories you allowed, enforced by the database. You can see every read, revoke any AI from any other, and ship
data to one buyer exclusively; the wallet then refuses resale and deletes its own copy. It can also find where your
data appears online and draft GDPR access and erasure requests for you to send.

Built in one day at Accel AI Innovate London, 15 Oct 2026. Expect rough edges.

## Run it yourself
| Path | Database + files | Server |
|---|---|---|
| Your own accounts | Your Supabase project (`supabase db push` runs `supabase/migrations/`) | Vercel, Root Directory = `server` |
| Your own infra | `docker compose up` (Postgres + pgvector, `db/` auto-loaded) | Docker container |
| Anything else | Any Postgres 15+ with pgvector, any S3-compatible storage | Any Node 20 host |

All configuration is environment variables (`.env.example`). Nothing is tied to the original authors' accounts.

## Add it to Claude
Settings → Connectors → Add custom connector → `https://<your-server>/mcp`. The wallet's own consent page lets you
pick which categories that AI may read.

## Test it
```
python3 seed/generate.py && python3 seed/linkedin.py && python3 seed/exposure.py
python3 eval/redteam.py        # scope, kill switch, resale guard
python3 eval/score.py          # chat-history import quality
python3 eval/linkedin_flow.py  # LinkedIn archive job, against the mock
python3 eval/linkedin_drift.py # wallet vs live LinkedIn, against the mock
python3 eval/exposure_flow.py  # find-my-data + GDPR requests, against a fake web
```
All test data is synthetic ("Dana Whitfield", `.example` sites).

## What's enforced vs promised
- **Enforced:** scope filtering in SQL; secrets never enter the canonical store; append-only ledger; instant revocation; no second grant on shipped exclusive data; wallet-side copy deleted on ship; exposure scans only for the verified owner; robots.txt respected; the wallet never sends email or logs into third-party sites.
- **Promised, not enforced:** that a person keeps no local copy of data they created. That is a contract term the ledger evidences.

## Licence
Apache-2.0. The web UI at the repo root was started in [Lovable](https://lovable.dev).
