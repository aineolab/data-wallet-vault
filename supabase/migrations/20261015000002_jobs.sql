-- Source jobs: long-running Data In flows (LinkedIn GDPR export first; GDPR archives from other providers later).
-- State machine:
--   REQUESTED -> AWAITING_ARCHIVE -> ARCHIVE_READY -> INGESTING -> AVAILABLE
--   any non-terminal -> CANCELLED (consent revoked) | EXPIRED (download window passed) | FAILED (parse error, retries exhausted)
CREATE TABLE IF NOT EXISTS source_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  consent_grant_id UUID NOT NULL REFERENCES consent_grants(id),
  provider TEXT NOT NULL CHECK (provider IN ('linkedin','linkedin_mock','chatgpt_export','claude_export')),
  archive_kind TEXT NOT NULL DEFAULT 'fast' CHECK (archive_kind IN ('fast','full')),   -- LinkedIn: ~10 min vs ~24 h
  state TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','AWAITING_ARCHIVE','ARCHIVE_READY','INGESTING','AVAILABLE','CANCELLED','EXPIRED','FAILED')),
  external_ref TEXT,                         -- provider request id (mock) or user note
  ready_hint_at TIMESTAMPTZ,                 -- when we expect the archive
  archive_expires_at TIMESTAMPTZ,            -- LinkedIn keeps the download ~72 h
  raw_file_id UUID REFERENCES raw_vault_files(id),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON source_jobs (next_check_at) WHERE state IN ('REQUESTED','AWAITING_ARCHIVE','ARCHIVE_READY','INGESTING');

-- Every transition is recorded; the owner's agent reads this to explain progress.
CREATE TABLE IF NOT EXISTS source_job_events (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES source_jobs(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS job_events_append_only ON source_job_events;
CREATE TRIGGER job_events_append_only BEFORE UPDATE OR DELETE ON source_job_events FOR EACH ROW EXECUTE FUNCTION block_mutation();

-- Aggregate-only social graph: never store individual connections (third-party personal data).
ALTER TABLE canonical_profiles ADD COLUMN IF NOT EXISTS social_graph_summary JSONB NOT NULL DEFAULT '{}';
ALTER TABLE raw_vault_files DROP CONSTRAINT IF EXISTS raw_vault_files_source_type_check;
ALTER TABLE raw_vault_files ADD CONSTRAINT raw_vault_files_source_type_check
  CHECK (source_type IN ('CHATGPT_EXPORT','CLAUDE_EXPORT','GDPR_ARCHIVE','LINKEDIN_EXPORT','IMAGE','AUDIO','VIDEO','COMPUTER_USE_TRACE'));

ALTER TABLE source_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_job_events ENABLE ROW LEVEL SECURITY;
