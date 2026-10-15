# Integration notes (lanes -> integrator)

Core = `src/index.ts`, `src/config.ts`, `src/db.ts`, `src/auth.ts`, `src/ledger.ts`, `src/scopes.ts`, `src/v1/index.ts`.
Lanes never edit the core. Need a core change? Add a request below with the exact diff you want; the integrator applies it.

## Contract the core gives you
- `requireOwner` / `requireToken` / `requireDataIn` (auth.ts) set `c.get('auth')`: `{tenantId, userId, tokenId, grantId, consumerName, consumerType, scopes, exclusive}`.
  **Demo mode:** no `Authorization` header on an owner/data-in route = the owner (the evals send none). A present header must be valid.
- `newToken()` / `hashToken()` for issuing bearer tokens (store only the hash in `data_out_tokens.token_hash`).
- `queryMemories({tenantId, userId, scopes, q, limit})` is the only way to read `canonical_memories`; the scope filter is in its SQL.
- `effectiveScopes(requested, tokenScopes)` -> `{served, blocked}`; write a `SCOPE_BLOCKED` ledger row whenever `blocked` is non-empty.
- `ledger({...})` appends one `egress_ledger` row; `readLedger()` returns the GET /v1/ledger shape.
- Error codes the evals look for: `WALLET_ACCESS_REVOKED` (401), `RESALE_BLOCKED` (409), `SCOPE_RESTRICTED` notice in query responses.

## Requests
(none yet)

### wallet-api lane (no core change needed; convention note for other lanes)
- `POST /v1/ship` shreds `raw_vault_files` under the grant and deletes their Storage objects. It recognises
  `storage_uri` of the form `supabase://vault/<path>`, `storage://vault/<path>`, `vault/<path>` or a full
  `<SUPABASE_URL>/storage/v1/object/.../vault/<path>` URL. `seed://…` and `file://…` are marked SHREDDED in the DB
  but have no Storage object to delete. Ingest lanes: please write one of the recognised forms.
- `server/scripts/seed-fixture.ts` is a TEMPORARY demo fixture (40 answer-key facts, `source_provider = 'seed_fixture'`).
  Delete those rows (`DELETE FROM canonical_memories WHERE source_provider = 'seed_fixture'`) once the Normalizer has run,
  otherwise `eval/score.py` precision is measured against the answer key itself.

### mcp lane (server/src/mcp/) — notes for the integrator and the other lanes
No core change needed. `/mcp` is stateless streamable HTTP (`WebStandardStreamableHTTPServerTransport`, fresh McpServer per
request, `enableJsonResponse`). `GET /mcp/health` lists both tool sets without a token. Smoke: `npx tsx --env-file=.env src/mcp/smoke.ts`.
Owner tools that belong to other lanes are thin HTTP proxies to `/v1` on the same origin (override with env `MCP_V1_BASE`),
forwarding the caller's bearer. Until a route exists the tool returns `NOT_AVAILABLE_YET`. Paths the proxies assume:
- `POST /v1/sources/linkedin/request {archive_kind, mock_delay_s?}` (wallet_request_linkedin_export)
- `POST /v1/jobs/:id/archive-ready` (wallet_archive_ready) — **linkedin lane: please expose this path**, or tell mcp the real one.
- `POST /v1/ingest` with a JSON body `{job_id?, source_url?}` (wallet_deposit from MCP has no file upload) — **linkedin lane: accept JSON as well as multipart**.
- `POST /v1/sources/linkedin/drift`, `POST /v1/sources/linkedin/apply-drift`
- `POST /v1/tokens/issue {consumer_name, consumer_type:'DATA_BUYER_API', scopes, exclusive}` (wallet_offer_to_buyer), `POST /v1/ship {grant_id}`
Owner search uses the OWNER token's own `allowed_scopes` (restricted only if the token carries it), so `/v1/tokens/issue` for
OWNER tokens should grant all five scopes.

### linkedin lane (branch `lane-linkedin`) — no core changes needed, four notes
1. **`eval/linkedin_flow.py` crashes after all 13 checks PASS.** Case 5 does `check(..., final["state"] == "FAILED" and final.get("last_error"), ...)`,
   which stores the `last_error` string instead of a bool, so `sum(ok for _, ok in results)` raises `TypeError`. One-char fix on that line:
   `bool(final.get("last_error"))`. (Lane rule says never edit `eval/*.py`, so this is for the integrator.)
2. **The flow eval assumes no earlier LinkedIn import in the DB.** Case 3 checks `raw_vault_files` grew by exactly 1, so a second run against the
   same DB fails case 3 (the archive is already stored, dedupe makes the delta 0). Before a re-run (or the pitch rehearsal):
   `UPDATE source_jobs SET raw_file_id = NULL WHERE provider IN ('linkedin','linkedin_mock'); DELETE FROM raw_vault_files WHERE source_type = 'LINKEDIN_EXPORT';`
   (memories cascade; profile is upserted on the next import; jobs/events are append-only and stay).
3. **Cron:** production needs `POST <PUBLIC_URL>/v1/jobs/tick` every 30 s (no body, no header = demo owner). Supabase: `pg_cron` + `pg_net`:
   `select cron.schedule('wallet-jobs-tick', '30 seconds', $$select net.http_post(url := '<PUBLIC_URL>/v1/jobs/tick', body := '{}'::jsonb) $$);`
   Self-host: a `setInterval` in `src/node.ts` (core, so not added by this lane) or `docker compose` sidecar with `curl`.
4. **Vercel has no `seed/`** (Root Directory = `server`). The mock looks for `seed/out/linkedin/*` locally, then falls back to
   `https://raw.githubusercontent.com/aineolab/data-wallet-vault/main/seed/out/linkedin/<file>`; `MOCK_LINKEDIN_SEED_DIR` env overrides the path.
   So the demo on Vercel works as long as `seed/out/linkedin/` is on `main` (it is today).

Ledger operations this lane writes (all accepted by `LedgerOperation`'s open string type): `FACTS_INGESTED` (consumer `linkedin_mock`/`linkedin`),
`CONSENT_REVOKED`, `LINKEDIN_DRIFT_CHECK`, `LINKEDIN_DRIFT_APPLIED`. Storage bucket `vault` is created on first use (service role).
Dependency added to `server/package.json`: `fflate` (zip parsing).

### exposure lane (branch `lane-exposure`, feature 13) — no core changes needed, five notes
Files: `src/exposure/{mockweb,scan,requests}.ts`, `src/v1/exposure.ts`, `public/seed/exposure/web_index.json` (static copy of
`seed/out/exposure/web_index.json` for Vercel). `eval/exposure_flow.py` 19/19 locally (MOCK_WEB=1, real Supabase DB).
1. **Vercel env:** set `MOCK_WEB_SEED_URL=https://data-wallet-server.vercel.app/seed/exposure` (the mock fetches
   `${MOCK_WEB_SEED_URL}/web_index.json` first, then local paths: repo `seed/out/exposure`, `server/public/seed/exposure`,
   or `MOCK_WEB_SEED_DIR`). If `seed/out/exposure/web_index.json` ever changes, re-copy it to `server/public/seed/exposure/`.
2. **Owner identifiers are auto-seeded in mock mode.** The eval never seeds `owner_identifiers` through the API, so with
   `MOCK_WEB=1` the first scan inserts Dana's five identifiers (`DEMO_OWNER_IDENTIFIERS` in `mockweb.ts`, mirrors
   `seed/out/exposure/exposure_key.json`, `verified_via = manual_attest`) when the table is empty. Outside mock mode the owner
   adds them: `POST /v1/owner-identifiers {kind, value, verified_via?}` · `GET` · `DELETE /v1/owner-identifiers/:id`.
3. **Clean-DB assumptions of the eval: none that block a re-run.** Rescans upsert on `UNIQUE (tenant_id, user_id, url)`
   and never overwrite the owner's confirm/deny; each run drafts fresh `privacy_requests` rows, and leftover SENT/OVERDUE rows
   from earlier runs just advance on the next tick. Re-run is 19/19 on a populated DB. To reset anyway (privacy_request_events
   is append-only, so delete children first):
   `DELETE FROM privacy_request_events; DELETE FROM privacy_requests; DELETE FROM exposures; DELETE FROM owner_identifiers;`
   Case 6 needs `CONSUMER_TOKEN` (any non-OWNER token, e.g. `POST /v1/tokens/issue {consumer_name, consumer_type:'AI_AGENT_MCP', scopes:['coding_preferences']}`); without it the eval reports that case as FAIL by design.
4. **Cron:** `POST <PUBLIC_URL>/v1/privacy-requests/tick` (no body, no header = demo owner) alongside the linkedin `/v1/jobs/tick`;
   daily is enough (deadlines are in days). With a real clock an OVERDUE request escalates 7 days later; the mock clock
   (`{now}` body, honoured only with `MOCK_WEB=1`) escalates on the next tick so the eval's two ticks pass.
5. **Live web search is not wired.** `MOCK_WEB=0` makes `POST /v1/exposure/scan` return `503 WEB_SEARCH_NOT_CONFIGURED`.
   A Tavily/Exa source only has to implement `WebSource` in `mockweb.ts` (`search(query)` -> URLs, `fetch(url)` -> page or
   `allowed:false` after a robots.txt check). Everything else (matching, confidence, namesakes, drafts) is source-independent.

Owner-only routes (core `requireOwner`, scoped to this lane's paths so it never wraps other lanes' routes): `POST /v1/exposure/scan {subject?}`,
`GET /v1/exposure`, `GET /v1/exposure/:id`, `POST /v1/exposure/:id/confirm {is_me}`, `POST /v1/privacy-requests {exposure_id, kind}`,
`GET /v1/privacy-requests`, `GET /v1/privacy-requests/:id`, `POST /v1/privacy-requests/:id/sent`, `POST /v1/privacy-requests/:id/event {type}`
(or `/:id/ack|data_received|completed|refused|withdrawn|extended`), `POST /v1/privacy-requests/tick {now?}`.
MCP lane: `wallet_scan_exposure`, `wallet_exposures`, `wallet_confirm_exposure`, `wallet_draft_privacy_request`, `wallet_mark_request_sent`,
`wallet_privacy_requests` map 1:1 onto those paths.
Ledger operations written (consumer `owner`): `EXPOSURE_SCAN`, `EXPOSURE_CONFIRMED`/`EXPOSURE_DENIED`, `PRIVACY_REQUEST_DRAFTED`,
`PRIVACY_REQUEST_SENT`, `PRIVACY_REQUEST_<EVENT>`, `PRIVACY_REQUEST_OVERDUE`, `PRIVACY_REQUEST_ESCALATED`. No new dependencies.
