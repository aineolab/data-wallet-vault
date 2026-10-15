-- Exposure Finder: where the OWNER's personal data appears online, and the GDPR requests sent about it.
-- Owner-only. Never readable by consumer tokens. Never run for anyone but the verified owner.

-- Identifiers the owner has verified as theirs. Scans may only use these.
CREATE TABLE IF NOT EXISTS owner_identifiers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('full_name','email','phone','username','city','employer')),
  value TEXT NOT NULL,
  verified_via TEXT NOT NULL CHECK (verified_via IN ('owner_login','email_code','linkedin_profile','manual_attest')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, kind, value)
);

-- One row per place the owner's data was found.
CREATE TABLE IF NOT EXISTS exposures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  site TEXT NOT NULL,
  site_type TEXT NOT NULL CHECK (site_type IN ('people_search','data_broker','social_profile','forum','news','breach_notice','search_engine','company_site','other')),
  data_found TEXT[] NOT NULL DEFAULT '{}',          -- e.g. {'full_name','city','phone','age_range','relatives'}
  match_confidence NUMERIC(3,2) NOT NULL,           -- how sure we are this is the owner, not a namesake
  owner_confirmed BOOLEAN,                          -- NULL = not reviewed, TRUE = me, FALSE = namesake
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  recommended_action TEXT NOT NULL CHECK (recommended_action IN ('access_request','erasure_request','opt_out_form','search_delisting','account_delete','monitor','none')),
  controller_contact TEXT,                          -- privacy email or form URL from the site's privacy policy
  evidence_snippet TEXT NOT NULL,                   -- the minimum text that shows the match (redacted beyond what's needed)
  found_by TEXT NOT NULL,                           -- 'tavily', 'exa', 'mock_web'
  found_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, url)
);

-- GDPR requests about an exposure. Art. 15 access, Art. 17 erasure, search delisting, opt-out.
-- State machine:
--   DRAFTED -> SENT -> ACKNOWLEDGED -> (DATA_RECEIVED) -> COMPLETED
--   SENT/ACKNOWLEDGED -> OVERDUE (past due_at) -> ESCALATED (complaint drafted to the data-protection authority)
--   any -> REFUSED | WITHDRAWN
CREATE TABLE IF NOT EXISTS privacy_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  exposure_id UUID NOT NULL REFERENCES exposures(id),
  kind TEXT NOT NULL CHECK (kind IN ('access_art15','erasure_art17','opt_out','search_delisting')),
  state TEXT NOT NULL DEFAULT 'DRAFTED' CHECK (state IN ('DRAFTED','SENT','ACKNOWLEDGED','DATA_RECEIVED','COMPLETED','OVERDUE','ESCALATED','REFUSED','WITHDRAWN')),
  channel TEXT NOT NULL CHECK (channel IN ('email','web_form','post')),
  draft_subject TEXT NOT NULL,
  draft_body TEXT NOT NULL,
  gmail_draft_id TEXT,                              -- set when the owner's agent creates the Gmail draft; the OWNER sends it
  sent_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,                               -- sent_at + 1 month (GDPR Art. 12(3)); extendable by 2 months if the controller says so
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS privacy_request_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES privacy_requests(id),
  from_state TEXT, to_state TEXT NOT NULL, note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS privacy_events_append_only ON privacy_request_events;
CREATE TRIGGER privacy_events_append_only BEFORE UPDATE OR DELETE ON privacy_request_events FOR EACH ROW EXECUTE FUNCTION block_mutation();

ALTER TABLE owner_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_request_events ENABLE ROW LEVEL SECURITY;
