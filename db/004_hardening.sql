-- Hardening: pinned search_path, consent guard gap, FK indexes.
-- Plain-Postgres copy of supabase/migrations/20261015000004_hardening.sql, minus the vector move:
-- here search_path is "$user", public, so moving vector to `extensions` would break unqualified `vector` refs.

-- Trigger functions with a pinned, empty search_path.
-- Neither touches a table; NEW/OLD comparisons resolve through pg_catalog, which is always searched.
CREATE OR REPLACE FUNCTION public.block_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'append-only table: % on %', TG_OP, TG_TABLE_NAME; END; $$;

-- Also guards tenant_id/user_id: a grant must never be reassigned to another owner.
CREATE OR REPLACE FUNCTION public.consent_limited_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.counterparty IS DISTINCT FROM OLD.counterparty
     OR NEW.allowed_scopes IS DISTINCT FROM OLD.allowed_scopes OR NEW.exclusive IS DISTINCT FROM OLD.exclusive
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'consent_grants: only status/revoked_at may change';
  END IF;
  RETURN NEW;
END; $$;

-- FK indexes for joins and cascades the server actually runs.
-- Pure tenant_id/user_id FKs skipped: single-tenant today, and idx_mem_scope/idx_ledger_time lead with tenant_id.
CREATE INDEX IF NOT EXISTS idx_mem_raw_file ON canonical_memories (raw_file_id);           -- ON DELETE CASCADE from shred
CREATE INDEX IF NOT EXISTS idx_raw_files_grant ON raw_vault_files (consent_grant_id);       -- revoke -> files under grant
CREATE INDEX IF NOT EXISTS idx_tokens_grant ON data_out_tokens (consent_grant_id);          -- revoke -> kill tokens
CREATE INDEX IF NOT EXISTS idx_ledger_token ON egress_ledger (token_id);                    -- per-token audit
CREATE INDEX IF NOT EXISTS idx_jobs_grant ON source_jobs (consent_grant_id);                -- revoke -> cancel jobs
CREATE INDEX IF NOT EXISTS idx_jobs_raw_file ON source_jobs (raw_file_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON source_job_events (job_id, created_at);    -- job timeline
CREATE INDEX IF NOT EXISTS idx_privacy_req_exposure ON privacy_requests (exposure_id);
CREATE INDEX IF NOT EXISTS idx_privacy_events_req ON privacy_request_events (request_id, created_at);
