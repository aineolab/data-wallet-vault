-- Data Wallet — self-hosted schema (v0.1, hackathon slice of PRD §2.2)
-- Single-user by default. tenant_id kept everywhere so multi-tenant is a config change later.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA extensions;  -- Supabase pre-creates `extensions` and keeps it on search_path

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);

-- Append-only. Triggers below block UPDATE/DELETE except status/revoked_at on revoke.
CREATE TABLE IF NOT EXISTS consent_grants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  direction TEXT NOT NULL CHECK (direction IN ('DATA_IN','DATA_OUT')),
  counterparty TEXT NOT NULL,                       -- 'chatgpt_export', 'claude_desktop', 'buyer_acme'
  allowed_scopes TEXT[] NOT NULL DEFAULT '{}',      -- deny by default
  exclusive BOOLEAN NOT NULL DEFAULT FALSE,         -- "Ship the Data": no further grants on covered data
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','EXPIRED','SHIPPED')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS raw_vault_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  consent_grant_id UUID NOT NULL REFERENCES consent_grants(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('CHATGPT_EXPORT','CLAUDE_EXPORT','GDPR_ARCHIVE','IMAGE','AUDIO','VIDEO','COMPUTER_USE_TRACE')),
  modality TEXT NOT NULL DEFAULT 'text' CHECK (modality IN ('text','image','audio','video','trace')),
  storage_uri TEXT NOT NULL,                        -- file:///vault/... (self-host) or s3://...
  sha256_checksum TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (sync_status IN ('PENDING','PROCESSING','AVAILABLE','FAILED','QUARANTINED','SHREDDED')),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, sha256_checksum)      -- idempotent re-import
);

CREATE TABLE IF NOT EXISTS canonical_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id) UNIQUE,
  schema_version TEXT NOT NULL DEFAULT '2026-10-15',
  identity_card JSONB NOT NULL DEFAULT '{}',
  work_history JSONB NOT NULL DEFAULT '[]',
  source_extensions JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS canonical_memories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  raw_file_id UUID NOT NULL REFERENCES raw_vault_files(id) ON DELETE CASCADE,
  scope_category TEXT NOT NULL CHECK (scope_category IN ('work_profile','coding_preferences','shopping_preferences','personal_memory','health_finance_restricted')),
  fact_assertion TEXT NOT NULL,
  confidence_score NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  source_provider TEXT NOT NULL,
  source_provenance_ref TEXT NOT NULL,              -- conversation_id#message_index, or media file id
  modality TEXT NOT NULL DEFAULT 'text',
  is_quarantined BOOLEAN NOT NULL DEFAULT FALSE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,          -- set by the Verifier agent
  embedding vector(1536),
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS data_out_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  consent_grant_id UUID NOT NULL REFERENCES consent_grants(id),
  consumer_name TEXT NOT NULL,
  consumer_type TEXT NOT NULL CHECK (consumer_type IN ('OWNER','DATA_IN_AGENT','AI_AGENT_MCP','DATA_BUYER_API')),
  token_hash TEXT NOT NULL UNIQUE,                  -- sha256 of the bearer token; plaintext shown once
  allowed_scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only ledger. Every read, every revoke, every ship.
CREATE TABLE IF NOT EXISTS egress_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  token_id UUID REFERENCES data_out_tokens(id),
  consumer_name TEXT NOT NULL,
  operation TEXT NOT NULL,                          -- MCP_SEARCH_MEMORIES | GET_IDENTITY_CARD | SCOPE_BLOCKED | TOKEN_REVOKED | DATA_SHIPPED | RESALE_BLOCKED
  scopes_requested TEXT[] NOT NULL DEFAULT '{}',
  scopes_served TEXT[] NOT NULL DEFAULT '{}',
  records_returned INT NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mem_scope ON canonical_memories (tenant_id, user_id, scope_category) WHERE is_quarantined = FALSE;
CREATE INDEX IF NOT EXISTS idx_ledger_time ON egress_ledger (tenant_id, user_id, created_at DESC);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table: % on %', TG_OP, TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_append_only ON egress_ledger;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON egress_ledger FOR EACH ROW EXECUTE FUNCTION block_mutation();

CREATE OR REPLACE FUNCTION consent_limited_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.direction <> OLD.direction OR NEW.counterparty <> OLD.counterparty
     OR NEW.allowed_scopes <> OLD.allowed_scopes OR NEW.exclusive <> OLD.exclusive OR NEW.granted_at <> OLD.granted_at THEN
    RAISE EXCEPTION 'consent_grants: only status/revoked_at may change';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS consent_guard ON consent_grants;
CREATE TRIGGER consent_guard BEFORE UPDATE ON consent_grants FOR EACH ROW EXECUTE FUNCTION consent_limited_update();
DROP TRIGGER IF EXISTS consent_no_delete ON consent_grants;
CREATE TRIGGER consent_no_delete BEFORE DELETE ON consent_grants FOR EACH ROW EXECUTE FUNCTION block_mutation();

-- Default single-user tenant for self-host
INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'self-host') ON CONFLICT DO NOTHING;
INSERT INTO users (id, tenant_id, email) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'owner@localhost') ON CONFLICT DO NOTHING;

-- Supabase: reached only by server/ with the service role. Lock out anon/authenticated.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_vault_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_out_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE egress_ledger ENABLE ROW LEVEL SECURITY;
