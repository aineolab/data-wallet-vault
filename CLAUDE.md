# Data Wallet — agent-native, open source, self-hostable

Accel AI Innovate London, 15 Oct 2026. **Connectors working 13:30 · feature freeze 14:30 · rehearsed 15:30 · pitch 16:00.**

## What it is
A wallet for a person's data that lives inside their AI agents. You deposit exports, the wallet
scrubs secrets and distils facts with provenance, and any agent you connect (Claude, ChatGPT) reads
only the scopes you granted. You can see every read, revoke from any agent, and ship data to a buyer
exclusively, after which the wallet refuses resale and destroys its own copy.

**Agent platforms come first, the webapp second.** Every owner action is an MCP tool.
The full vision lives in `docs/PRD.md`. Today we build only the slice below.

## Architecture (decided)

```
Claude / ChatGPT ──MCP (OAuth)──▶ server/  (own Node project, Vercel; Docker for self-host)
Claude Code ──MCP (Bearer)─────▶   ├─ /mcp            one endpoint; tools depend on token type
Hosted agents ──REST (DATA_IN)──▶   ├─ /v1/*           internal API used by agents
                                    ├─ /authorize …    OAuth server + consent page (plain HTML)
                                    └─ /statement      read-only ledger + kill switch page
                                           │ DATABASE_URL + service role (server env only)
                                           ▼
                                   Supabase: Postgres + pgvector, Storage bucket `vault`
```

- **`server/` is its own Node project.** It has its own `package.json` and is deployed to Vercel with Root Directory = `server`. It is never part of the Lovable app at the repo root. Lovable must not edit `server/`, `supabase/`, `seed/`, `eval/` or `agents/` (see `AGENTS.md`).
- **Framework:** Hono, so the same code runs on Vercel functions and in Node/Docker (`@hono/node-server`). MCP uses `@modelcontextprotocol/sdk` streamable HTTP in stateless mode. Database access uses `pg`. Storage uses `@supabase/supabase-js` with the service role key.
- **The Lovable app at the root is optional polish.** It may call `/v1` read endpoints and nothing else. It never holds a service key.
- **Self-hosting:** run `docker compose up` with Postgres + pgvector and the server container. Every config value comes from env: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_URL`, `ANTHROPIC_API_KEY`. Nothing is tied to our Supabase or Vercel project.

## Non-negotiables
1. Scope is enforced in SQL: `scope_category = ANY($scopes) AND is_quarantined = FALSE`. Never trust a model to filter.
2. `health_finance_restricted` is never served unless the token explicitly carries it, and the consent page never offers it by default.
3. Zero planted secrets reach `canonical_memories` or `canonical_profiles`.
4. Every fact has `source_provenance_ref`. No provenance, no row.
5. `egress_ledger` and `consent_grants` are append-only (DB triggers). Every read, block, revoke and ship writes a ledger row.
6. Token checks hit Postgres on every request. No caching, so revocation takes effect on the next call.
7. Never edit `seed/out/*` or `eval/*.py` to make a score pass.
8. The only user is the synthetic "Dana Whitfield".
9. Lovable syncs `main`: work on branches, open PRs, never force-push.

## MCP tools (one endpoint, `tools/list` filtered by token)
| Owner token | Consumer token (read-only, `readOnlyHint: true`) |
|---|---|
| `wallet_request_linkedin_export`, `wallet_archive_ready`, `wallet_linkedin_drift`, `wallet_linkedin_apply_drift`, `wallet_deposit`, `wallet_job_status`, `wallet_search`, `wallet_connections`, `wallet_revoke`, `wallet_statement`, `wallet_offer_to_buyer`, `wallet_ship` | `wallet_get_identity_card`, `wallet_search_memories` |

## LinkedIn GDPR export flow (priority Data In source)
How LinkedIn really works: Settings & Privacy → "Get a copy of your data". A fast archive (profile,
connections, messages…) takes ~10 min; the full archive takes ~24 h. LinkedIn emails when it's ready,
the download lasts ~72 h, and re-requests are rate-limited. Requesting needs the user's password, so
**the wallet never automates the LinkedIn site** (that also breaches LinkedIn's terms). The agent guides,
tracks and ingests; the human clicks the two buttons.

```
REQUESTED ─▶ AWAITING_ARCHIVE ─▶ ARCHIVE_READY ─▶ INGESTING ─▶ AVAILABLE
     └──────────────┴──────────────────┴──────────────┴─▶ CANCELLED (consent revoked) | EXPIRED (72 h passed) | FAILED (parse, 3 retries)
```
- `wallet_request_linkedin_export {archive_kind: fast|full}` creates the `DATA_IN` grant + `source_jobs` row and returns the
  deep link and two-line instructions. State becomes `AWAITING_ARCHIVE` once the user confirms they clicked.
- **Tracking is agent-side:** the owner's own agent (which has their Gmail connector) watches for LinkedIn's "your data is ready"
  email and calls `wallet_archive_ready {job_id}`. The wallet never gets inbox access.
- The user downloads the zip and deposits it (`wallet_deposit` or `POST /v1/ingest` with `job_id`) → `INGESTING`.
- **Ingest rules:** Profile → `identity_card`; Positions + Education → `work_history`; Skills → `work_profile` facts with
  provenance `linkedin:Skills.csv#row`; Connections → **count and top companies only** in `social_graph_summary`
  (never names, URLs or emails, because they're other people's data); messages.csv → **skipped by default**.
- `POST /v1/jobs/tick` advances due jobs (expiry, retries, cancel on revoked grant). Production: Supabase Cron calls it
  every 30 s. Self-host: a loop in the server container. Tests call it directly.
- **Mock provider (`MOCK_LINKEDIN=1`, `provider = linkedin_mock`):** the same state machine, but the "archive" becomes ready
  after `mock_delay_s` (default 60) and is `seed/out/linkedin/*.zip`. `mock_outcome: ok|expired|corrupt` drives failure tests.
  The mock auto-advances `AWAITING_ARCHIVE → ARCHIVE_READY → INGESTING` on tick, so the full flow runs hands-free in demos.
- **Test:** `eval/linkedin_flow.py` (7 cases: happy path, privacy, idempotency, expired, corrupt, revoked mid-wait, events).

### Live LinkedIn API + drift check (wallet vs live)
LinkedIn's only rich member-data API is the **Member Data Portability API** (DMA). It is available only to members located
in the **EEA or Switzerland**. Self-serve: create an app with the default "Member Data Portability (Member) Default Company"
page, request the product, and mint a token in the OAuth Token Generator with scope `r_dma_portability_self_serve`
(valid ~1 year). Third-party apps use `r_dma_portability_3rd_party` with an authorization-code flow.
- `GET https://api.linkedin.com/rest/memberSnapshotData?q=criteria&domain=<DOMAIN>&start=&count=` with header
  `Linkedin-Version: 202312` (the only version accepted). The response is `elements[0].snapshotData`, a list of records
  **using the same keys as the export CSVs**, so write ONE parser (`server/src/linkedin/parse.ts`) for zip rows and API rows.
- Page until the API says "No data found for this memberId"; `paging.total` is unreliable. Rate limits are undocumented, so cache.
- **Allowlist only:** PROFILE, POSITIONS, EDUCATION, SKILLS, CONNECTIONS (count only). Never request INBOX, LOGIN,
  SECURITY_CHALLENGE_PIPE, PHONE_NUMBERS, EMAIL_ADDRESSES, IDENTITY_CREDENTIALS_AND_ASSETS or PREMIUM_NOTES.
- Sign-in with LinkedIn (OIDC, scopes `openid profile email`) gives only name, email and picture. Use it for a
  "verified LinkedIn identity" badge at most. It is not a data source.
- `POST /v1/sources/linkedin/drift` (owner; MCP `wallet_linkedin_drift`) fetches the live snapshot, diffs it against the
  wallet per domain (added / removed / changed; connections as counts), writes a `LINKEDIN_DRIFT_CHECK` ledger row and
  **changes nothing**. `POST /v1/sources/linkedin/apply-drift` (MCP `wallet_linkedin_apply_drift`) applies it after the
  owner says yes.
- Outside the EEA (Tim is UK-based) the wallet falls back to the archive flow, and the drift check compares two archives
  instead: the owner's agent asks them to request a fresh fast archive monthly (`wallet_request_linkedin_export`), and the
  drift diff runs on archive vs archive. **No computer-use or browser automation of LinkedIn** (Tim decided, 15 Oct):
  it breaches LinkedIn's terms and risks the owner's account.
- **Mock:** with `MOCK_LINKEDIN=1` the live source serves `seed/out/linkedin/api_snapshot.json` in the real response shape,
  with deliberate drift (promotion, new role, -Fastify +Rust, new headline, +3 connections).
- **Test:** `eval/linkedin_drift.py` (expected changes found, allowlist respected, counts only, read-only, ledgered).
- **Real token:** env `LINKEDIN_DMA_TOKEN` (owner's own token, never committed). Run against Tim's real account only
  off-screen, and only if his LinkedIn location is in the EEA.
- Schema: `db/002_jobs.sql` (`source_jobs`, append-only `source_job_events`, `social_graph_summary`).

Out-of-scope request → empty result + `SCOPE_RESTRICTED` notice + `SCOPE_BLOCKED` ledger row.
Revoked token → HTTP 401 `WALLET_ACCESS_REVOKED`. A new grant on scopes covered by a shipped exclusive grant → `RESALE_BLOCKED`.

## Independent evals on NYO (Claude builds, other models grade)
Claude writes the code and runs the agents. Models on **NYO** (Tim's OpenAI-compatible gateway) do the grading that
a fixed script can't, so the work never grades itself. `eval/judge.py`, env `NYO_BASE_URL` + `NYO_API_KEY`.
| Job | Model | When |
|---|---|---|
| Fact precision audit (is each fact supported by its source?) | `glm-5.3` | every hill-climb iteration |
| Same audit, final number for the pitch | `gpt-6-astra` (`FINAL=1`) | once, at the end |
| GDPR draft quality (article, controller, no over-sharing) | `gpt-6-astra` | after exposure_flow passes |
| New prompt injections for the red team | `deepseek-v4-pro` | once per wave; feed into `redteam.py` |
| Image captions for media rows (feature 10) | `minicpm-v-4.5` | once |
| Code review of `server/` scope + auth code | `kimi-k2.7-code` | before each wave's merge |
Rules: **only synthetic seed data goes to NYO** (it may record requests). Never real user data, never tokens or keys.
`gpt-6-astra` is ~10× the price of the others, so use it for final numbers only. Report which model produced each number.

## Exposure Finder + right-to-be-forgotten (feature 13)
Find where the **owner's own** personal data appears online, show the sources, recommend a workflow per source,
and draft GDPR requests: Art. 15 access ("send me what you hold"), Art. 17 erasure ("delete it"), opt-out forms,
and search-engine delisting. Track each request to its one-month deadline (Art. 12(3)).

**Guardrails (non-negotiable, tested):**
- Scans use only `owner_identifiers` the owner has verified. Any other subject → `403 SUBJECT_NOT_OWNER`.
  Never search relatives, colleagues or namesakes, even when a page names them.
- Results are owner-only. Consumer tokens never see `exposures` or `privacy_requests`.
- Search through Tavily/Exa APIs, and fetch only public pages that `robots.txt` allows. Skipped pages are listed as
  "couldn't check". No logins, no CAPTCHA solving, no scraping LinkedIn.
- Namesakes are shown as "probably not you" (confidence < 0.5) and never acted on until the owner confirms.
- **The wallet never sends anything.** It drafts; the owner's agent creates a Gmail draft; the owner presses send and
  tells the wallet ("I sent it"). Drafts include only what's needed to identify the owner, never more personal data.
- `evidence_snippet` stores the minimum text that shows the match.

**Flow:**
```
scan → exposures (site, data found, risk, confidence) → owner confirms "that's me" →
  recommended action: access_request | erasure_request | opt_out_form | search_delisting | monitor | none
  → privacy_request: DRAFTED → SENT → ACKNOWLEDGED → DATA_RECEIVED → COMPLETED
                         └─ no reply in 30 days → OVERDUE → ESCALATED (complaint drafted to the data-protection authority)
```
- Access before erasure when the owner wants a copy (e.g. a data broker): what comes back can be deposited into the wallet.
- MCP owner tools: `wallet_scan_exposure`, `wallet_exposures`, `wallet_confirm_exposure`, `wallet_draft_privacy_request`,
  `wallet_mark_request_sent`, `wallet_privacy_requests`. REST in `eval/exposure_flow.py`'s docstring.
- Schema: `db/003_exposure.sql`. **Mock:** `MOCK_WEB=1` answers searches from `seed/out/exposure/web_index.json`
  (8 fictional `.example` pages: 5 real hits, 1 namesake dentist in Bristol, 1 employer-only news page, 1 robots-blocked site).
  The mock clock (`tick {now}`) is allowed only in mock mode. **Test:** `eval/exposure_flow.py` (9 cases).

## OAuth (for claude.ai and ChatGPT)
- Unauthenticated `/mcp` → `401` with `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"`.
- Serve RFC 9728 protected-resource metadata (`resource` = `<PUBLIC_URL>/mcp` exactly) and RFC 8414 AS metadata with `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, and `offline_access` in `scopes_supported`.
- `/register` (DCR, JSON) · `/authorize` (consent page = scope picker; approving writes `consent_grants`) · `/token` (form-urlencoded; rotate refresh tokens; revoked grant → `invalid_grant`).
- Allowed redirects: `https://claude.ai/api/mcp/auth_callback`, ChatGPT's callback, and loopback `http://localhost/*` / `http://127.0.0.1/*` (any port).
- The owner's own login is an `OWNER_PASSPHRASE` env var for today. Real auth is roadmap.
- **Fallback:** `/v1/tokens/issue` mints a bearer token for `claude mcp add --transport http <url>/mcp --header "Authorization: Bearer …"`.

## Internal REST (`/v1`, used by agents and evals)
```
POST   /v1/tokens/issue   {consumer_name, consumer_type, scopes[], exclusive?}  (owner) -> {token, token_id, grant_id}
POST   /v1/ingest         file upload -> Storage `vault`, sha256 dedupe          -> {raw_file_id, job_id}
POST   /v1/facts          (DATA_IN token) [{fact, category, confidence, provenance, raw_file_id, modality}]
POST   /v1/memories/query {query, category?, limit?}  Bearer -> {records:[{fact,category,provenance}], notice?}
GET    /v1/profile        Bearer
DELETE /v1/tokens/{id}
POST   /v1/ship           {grant_id} -> signed URL to buyer, delete Storage object, SHREDDED, ledger DATA_SHIPPED
GET    /v1/ledger         -> {entries:[{created_at, consumer_name, operation, scopes_requested, scopes_served, records_returned}]}
GET    /v1/connections    (owner) -> {connections:[{token_id, consumer_name, consumer_type, allowed_scopes, expires_at, is_revoked, exclusive}]}
GET    /v1/jobs           (owner) -> {jobs:[{id, provider, state, created_at, updated_at, summary?}]}
GET    /v1/exposure       (owner) -> {exposures:[...]}      GET /v1/privacy-requests (owner) -> {requests:[...]}
```
**Lovable dashboard (feature 12) reads exactly these shapes.** Enable CORS for the dashboard origin
(`*.lovable.app` plus env `DASHBOARD_ORIGIN`) on GET /v1/ledger, /v1/connections, /v1/jobs, /v1/exposure,
/v1/privacy-requests and DELETE /v1/tokens/{id}. All require the owner bearer token.

## Demo cut (Tim decided ~12:50, 15 Oct)
Demo = features **1, 2, 3, 4** (must pass first), then **6, 13, 12** in parallel. Lovable (12) is being built from the
chat session via the Lovable connector, in parallel with Claude Code. Everything else stays in the repo and goes on
the roadmap slide. Hard stop 14:30.

## Build waves (all 13 features are Musts; Tim confirmed each one, 15 Oct)
Build in this order. Run each wave's lanes in parallel (subagents in separate worktrees). **Hard cut line at 14:30:**
anything whose test isn't green then is left out of the demo, stays in the repo, and goes on the roadmap slide.

| Wave | Features (Tim's numbering) | Green when | By |
|---|---|---|---|
| **1 Core wallet** | 1 Wallet inside Claude (MCP, owner + consumer tools) · 2 Scope enforced in SQL, restricted locked · 3 Statement + kill switch · 11 Open source (env-only config, Docker, README with 3 deploy paths) | `eval/redteam.py` passes against the Vercel URL via Claude Code bearer | 12:45 |
| **2 Data in** | 4 LinkedIn download flow (mock, Gmail-ready signal, cron tick) · 5 LinkedIn live drift check (mock DMA API) · 6 Chat-history Normalizer + Scrubber as a hosted agent with first + final score · 10 Image + audio rows in Storage with caption facts · 13 Exposure Finder + GDPR requests (mock web) | `eval/linkedin_flow.py`, `eval/linkedin_drift.py`, `eval/score.py`, `eval/exposure_flow.py` pass; media rows queryable | 13:45 |
| **3 Reach + polish** | 7 OAuth connect = consent (claude.ai) · 9 ChatGPT connector live (read-only) · 8 Ship exclusively + `RESALE_BLOCKED` · 12 Lovable dashboard (statement + kill switch, calls `/v1` only) | claude.ai + ChatGPT demo path end to end; resale case in `redteam.py` passes | 14:30 |
| **Not today** | Browser automation of LinkedIn, Data Sourcer agent, Minting Facility, computer-use/video data, buyer webhooks, multi-tenant, KMS. Real LinkedIn DMA check with Tim's token only off-screen, only if time remains | roadmap slide | — |

Lovable (feature 12) is built in the Lovable editor or by a lane that edits only `src/` at the repo root. It never
touches `server/`, and it never holds a service key.

## Hosted agents (Anthropic five-step loop)
- **Normalizer (Lane A):** reads `seed/out/conversations.json`, calls the Scrubber (Lane B, a pure function in `server/src/scrub.ts`) on each message, and posts facts to `/v1/facts`. Run it once early so the wallet has data by 13:00. Then hill-climb its prompt.
- **Finish line:** `eval/score.py` recall ≥ 0.90, precision ≥ 0.95, 0 secret leaks. `eval/redteam.py` passes. Record the FIRST score in `eval/RESULTS.md` before tuning. Cap hill-climbing at 45 minutes.

## Demo path (rehearse twice)
0. Claude (start of pitch): "Get my LinkedIn data into my wallet." → job created, mock delay 120 s, runs while you talk.
   Two minutes later: "Is my LinkedIn import done?" → AVAILABLE, 3 roles, 8 skills, 120 connections counted, none stored by name.
   "Is my wallet still up to date with LinkedIn?" → drift: promoted to Staff, new acting-manager role, +Rust −Fastify, +3 connections. "Apply it."
1. Claude: "Deposit this export into my wallet." → job runs. "What did it find? Any secrets?"
2. ChatGPT (or a second Claude chat) with coding_preferences only: "What stack should I use?" → answered from the wallet.
3. Same agent: "What's my mortgage situation?" → `SCOPE_RESTRICTED`.
4. Claude: "Who read my wallet today? Revoke ChatGPT." → the next ChatGPT call fails.
5. Claude: "Ship my shopping data to Acme, exclusive." → offering it to a second buyer → `RESALE_BLOCKED`.

Say aloud: the user is synthetic, the export is seeded, the tests are ours. Claim: "the wallet refuses resale and destroys its own copy", never "no copies exist anywhere".
