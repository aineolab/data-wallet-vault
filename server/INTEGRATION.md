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
