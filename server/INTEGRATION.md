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
