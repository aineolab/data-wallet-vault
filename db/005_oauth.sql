-- OAuth server state for claude.ai / ChatGPT connectors (CLAUDE.md "OAuth").
-- Clients come from dynamic registration; codes are single-use; refresh tokens rotate.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,                               -- client_id
  client_name TEXT NOT NULL,
  redirect_uris TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,                      -- S256 only
  token_id UUID NOT NULL REFERENCES data_out_tokens(id),
  access_token TEXT NOT NULL,                        -- plaintext bearer, held only until the code is exchanged
  scopes TEXT[] NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  token_id UUID NOT NULL REFERENCES data_out_tokens(id),
  consent_grant_id UUID NOT NULL REFERENCES consent_grants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_exp ON oauth_codes (expires_at);

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
