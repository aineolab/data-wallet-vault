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
