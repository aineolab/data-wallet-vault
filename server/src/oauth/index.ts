// OAuth 2.1 authorization server for MCP clients (claude.ai, ChatGPT, loopback CLIs). CLAUDE.md "OAuth".
//   /.well-known/oauth-protected-resource   RFC 9728  resource = <PUBLIC_URL>/mcp
//   /.well-known/oauth-authorization-server RFC 8414  PKCE S256 only, public clients (token_endpoint_auth none)
//   POST /register                          RFC 7591  dynamic client registration
//   GET|POST /authorize                     consent page: OWNER_PASSPHRASE + role + scope picker -> consent_grants + token
//   POST /token                             authorization_code (PKCE) | refresh_token (rotating)
// Approving consent IS the grant: it writes consent_grants + data_out_tokens exactly like /v1/tokens/issue.
import { Hono, type Context } from 'hono'
import { html } from 'hono/html'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { OWNER, hashToken, newToken, type ConsumerType } from '../auth.js'
import { config, publicUrl } from '../config.js'
import { db, query } from '../db.js'
import { ledger } from '../ledger.js'
import { ALL_SCOPES, DEFAULT_SCOPES, RESTRICTED, isScope, type Scope } from '../scopes.js'

const oauth = new Hono()

const TOKEN_TTL_DAYS = 30
const CODE_TTL_S = 300
const ALLOWED_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chat.openai.com/connector_platform_oauth_redirect',
  'https://platform.openai.com/apps-manage/oauth/callback',
]
const SCOPE_LABEL: Record<Scope, string> = {
  work_profile: 'Work profile: roles, employer, skills',
  coding_preferences: 'Coding preferences: stack, style, tools',
  shopping_preferences: 'Shopping preferences',
  personal_memory: 'Personal memory: habits, goals, plans',
  health_finance_restricted: 'Health & finance (restricted: off by default)',
}

const b64url = (b: Buffer) => b.toString('base64url')
const sha256 = (s: string) => createHash('sha256').update(s).digest()
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function redirectAllowed(uri: string): boolean {
  if (ALLOWED_REDIRECTS.includes(uri)) return true
  try {
    const u = new URL(uri)
    // Loopback clients (claude mcp add, MCP Inspector): any port, any path, http only.
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

const err = (c: Context, status: 400 | 401, error: string, description: string) =>
  c.json({ error, error_description: description }, status)

// ---------------------------------------------------------------------------------------------------------------
// Discovery. Both the root and the path-suffixed forms, because clients derive the URL from the resource path.
// ---------------------------------------------------------------------------------------------------------------
const protectedResource = (base: string) => ({
  resource: `${base}/mcp`,
  authorization_servers: [base],
  bearer_methods_supported: ['header'],
  scopes_supported: [...ALL_SCOPES, 'offline_access'],
  resource_name: 'Data Wallet',
})
const authServer = (base: string) => ({
  issuer: base,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  registration_endpoint: `${base}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [...ALL_SCOPES, 'offline_access'],
  service_documentation: 'https://github.com/aineolab/data-wallet-vault',
})
for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])
  oauth.get(p, (c) => c.json(protectedResource(publicUrl(c.req.url))))
for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'])
  oauth.get(p, (c) => c.json(authServer(publicUrl(c.req.url))))

// ---------------------------------------------------------------------------------------------------------------
// POST /register (RFC 7591). Public clients only; every redirect must be on the allowlist or loopback.
// ---------------------------------------------------------------------------------------------------------------
oauth.post('/register', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return err(c, 400, 'invalid_client_metadata', 'Body must be JSON')
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
  if (!uris.length) return err(c, 400, 'invalid_redirect_uri', 'redirect_uris is required')
  const bad = uris.filter((u) => !redirectAllowed(u))
  if (bad.length) return err(c, 400, 'invalid_redirect_uri', `Redirect not allowed: ${bad.join(', ')}`)
  const name = (typeof body.client_name === 'string' && body.client_name.trim()) || 'MCP client'
  const id = `dwc_${b64url(randomBytes(18))}`
  await query(`INSERT INTO oauth_clients (id, client_name, redirect_uris) VALUES ($1, $2, $3::text[])`, [id, name.slice(0, 100), uris])
  return c.json(
    {
      client_id: id,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  )
})

// ---------------------------------------------------------------------------------------------------------------
// /authorize: the consent page. GET renders it, POST (same query string) approves or denies.
// ---------------------------------------------------------------------------------------------------------------
interface AuthzReq {
  client: { id: string; client_name: string; redirect_uris: string[] }
  redirectUri: string
  state: string
  codeChallenge: string
  requestedScopes: Scope[]
}

async function parseAuthz(q: Record<string, string | undefined>): Promise<AuthzReq | { fatal: string } | { redirectError: string; redirectUri: string; state: string }> {
  const clientId = q.client_id ?? ''
  const { rows } = await query<{ id: string; client_name: string; redirect_uris: string[] }>(`SELECT id, client_name, redirect_uris FROM oauth_clients WHERE id = $1`, [clientId])
  const client = rows[0]
  if (!client) return { fatal: 'Unknown client_id. Register first (POST /register).' }
  const redirectUri = q.redirect_uri ?? client.redirect_uris[0] ?? ''
  if (!client.redirect_uris.includes(redirectUri) || !redirectAllowed(redirectUri)) return { fatal: 'redirect_uri is not registered for this client.' }
  const state = q.state ?? ''
  if (q.response_type !== 'code') return { redirectError: 'unsupported_response_type', redirectUri, state }
  if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256') return { redirectError: 'invalid_request', redirectUri, state }
  const requestedScopes = (q.scope ?? '').split(/[\s+]+/).filter(isScope)
  return { client, redirectUri, state, codeChallenge: q.code_challenge, requestedScopes }
}

const redirectWith = (uri: string, params: Record<string, string>) => {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v)
  return u.toString()
}

function consentPage(req: AuthzReq, opts: { error?: string; csrf: string }) {
  const preset = req.requestedScopes.length ? req.requestedScopes : DEFAULT_SCOPES
  const rows = ALL_SCOPES.map(
    (s) => html`<label class="scope ${s === RESTRICTED ? 'restricted' : ''}">
      <input type="checkbox" name="scope" value="${s}" ${preset.includes(s) && s !== RESTRICTED ? 'checked' : ''} />
      <span><b>${s}</b><br /><small>${SCOPE_LABEL[s]}</small></span>
    </label>`,
  )
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Data Wallet: connect ${req.client.client_name}</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--fg:#e8eaf0;--mut:#9aa3b2;--acc:#6ee7b7;--warn:#fbbf24;--err:#f87171;--line:#2a2f3a}
  @media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--card:#fff;--fg:#111;--mut:#555;--line:#e3e6ea}}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center;padding:24px 16px}
  main{max-width:560px;width:100%}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
  h1{font-size:20px;margin:0 0 6px} p{margin:6px 0 14px;color:var(--mut)}
  fieldset{border:0;padding:0;margin:0 0 16px}
  legend{font-weight:600;margin-bottom:8px}
  .role,.scope{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer}
  .restricted{border-color:var(--warn)} .restricted small{color:var(--warn)}
  input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font-size:16px}
  .actions{display:flex;gap:10px;margin-top:18px}
  button{flex:1;padding:12px;border-radius:10px;border:1px solid var(--line);font-size:16px;cursor:pointer;background:transparent;color:var(--fg)}
  button.primary{background:var(--acc);color:#06241a;border-color:var(--acc);font-weight:600}
  .error{color:var(--err);margin:0 0 12px}
  small{color:var(--mut)}
  #scopes.off{opacity:.45;pointer-events:none}
</style></head>
<body><main><form method="post" class="card">
  <h1>Connect <em>${req.client.client_name}</em> to your Data Wallet</h1>
  <p>The wallet serves only the scopes you tick. Every read is written to your statement, and you can revoke this connection from any agent at any time.</p>
  ${opts.error ? html`<p class="error">${opts.error}</p>` : ''}
  <input type="hidden" name="csrf" value="${opts.csrf}" />
  <fieldset>
    <legend>Connect as</legend>
    <label class="role"><input type="radio" name="role" value="owner" checked onchange="document.getElementById('scopes').classList.add('off')" /><span><b>Owner</b><br /><small>Your own agent. Full control: import, search every scope, see who read what, revoke, ship.</small></span></label>
    <label class="role"><input type="radio" name="role" value="consumer" onchange="document.getElementById('scopes').classList.remove('off')" /><span><b>Read-only agent</b><br /><small>Only the scopes ticked below. Out-of-scope requests return nothing and are logged.</small></span></label>
  </fieldset>
  <fieldset id="scopes" class="off"><legend>Scopes for a read-only agent</legend>${rows}</fieldset>
  <fieldset><legend>Owner passphrase</legend><input type="password" name="passphrase" autocomplete="current-password" required /></fieldset>
  <div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="approve" class="primary">Approve</button></div>
</form></main></body></html>`
}

oauth.get('/authorize', async (c) => {
  const parsed = await parseAuthz(c.req.query())
  if ('fatal' in parsed) return c.html(html`<!doctype html><p style="font-family:system-ui;padding:24px">${parsed.fatal}</p>`, 400)
  if ('redirectError' in parsed) return c.redirect(redirectWith(parsed.redirectUri, { error: parsed.redirectError, state: parsed.state }))
  const csrf = b64url(sha256(`${parsed.codeChallenge}:${config().OWNER_PASSPHRASE}`))
  return c.html(consentPage(parsed, { csrf }))
})

oauth.post('/authorize', async (c) => {
  const parsed = await parseAuthz(c.req.query())
  if ('fatal' in parsed) return c.html(html`<!doctype html><p style="font-family:system-ui;padding:24px">${parsed.fatal}</p>`, 400)
  if ('redirectError' in parsed) return c.redirect(redirectWith(parsed.redirectUri, { error: parsed.redirectError, state: parsed.state }))
  const form = await c.req.parseBody({ all: true })
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const csrf = b64url(sha256(`${parsed.codeChallenge}:${config().OWNER_PASSPHRASE}`))
  if (!safeEq(str(form.csrf), csrf)) return c.html(consentPage(parsed, { csrf, error: 'The form expired. Try again.' }), 400)
  if (str(form.decision) !== 'approve') return c.redirect(redirectWith(parsed.redirectUri, { error: 'access_denied', state: parsed.state }))
  if (!safeEq(str(form.passphrase), config().OWNER_PASSPHRASE)) return c.html(consentPage(parsed, { csrf, error: 'Wrong passphrase.' }), 401)

  const role = str(form.role) === 'consumer' ? 'consumer' : 'owner'
  const ticked = (Array.isArray(form.scope) ? form.scope : [form.scope]).map(str).filter(isScope)
  const scopes: Scope[] = role === 'owner' ? [...ALL_SCOPES] : [...new Set(ticked)]
  if (!scopes.length) return c.html(consentPage(parsed, { csrf, error: 'Tick at least one scope for a read-only agent.' }), 400)
  const consumerType: ConsumerType = role === 'owner' ? 'OWNER' : 'AI_AGENT_MCP'
  const consumerName = parsed.client.client_name.slice(0, 100)

  // Approving IS the grant: consent_grants + data_out_tokens, the same rows /v1/tokens/issue writes.
  const token = newToken()
  const client = await db().connect()
  let tokenId: string
  let grantId: string
  try {
    await client.query('BEGIN')
    const g = await client.query<{ id: string }>(
      `INSERT INTO consent_grants (tenant_id, user_id, direction, counterparty, allowed_scopes, exclusive, status)
       VALUES ($1, $2, 'DATA_OUT', $3, $4::text[], FALSE, 'ACTIVE') RETURNING id`,
      [OWNER.tenantId, OWNER.userId, consumerName, scopes],
    )
    grantId = g.rows[0]!.id
    const t = await client.query<{ id: string }>(
      `INSERT INTO data_out_tokens (tenant_id, user_id, consent_grant_id, consumer_name, consumer_type, token_hash, allowed_scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW() + ($8 || ' days')::interval) RETURNING id`,
      [OWNER.tenantId, OWNER.userId, grantId, consumerName, consumerType, hashToken(token), scopes, String(TOKEN_TTL_DAYS)],
    )
    tokenId = t.rows[0]!.id
    const code = `dwa_${b64url(randomBytes(24))}`
    await client.query(
      `INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, token_id, access_token, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW() + ($8 || ' seconds')::interval)`,
      [code, parsed.client.id, parsed.redirectUri, parsed.codeChallenge, tokenId, token, scopes, String(CODE_TTL_S)],
    )
    await client.query('COMMIT')
    await ledger({
      ...OWNER,
      tokenId,
      consumerName,
      operation: 'TOKEN_ISSUED',
      scopesRequested: parsed.requestedScopes,
      scopesServed: scopes,
      detail: { via: 'oauth_consent', consumer_type: consumerType, client_id: parsed.client.id, grant_id: grantId },
    })
    return c.redirect(redirectWith(parsed.redirectUri, { code, state: parsed.state }))
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
})

// ---------------------------------------------------------------------------------------------------------------
// POST /token (form-urlencoded or JSON). Public client: PKCE is the proof.
// ---------------------------------------------------------------------------------------------------------------
oauth.post('/token', async (c) => {
  const ct = c.req.header('content-type') ?? ''
  let p: Record<string, string> = {}
  if (ct.includes('application/json')) {
    try {
      const j = (await c.req.json()) as Record<string, unknown>
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string') p[k] = v
    } catch {
      return err(c, 400, 'invalid_request', 'Malformed JSON body')
    }
  } else {
    const form = await c.req.parseBody()
    for (const [k, v] of Object.entries(form)) if (typeof v === 'string') p[k] = v
  }
  c.header('Cache-Control', 'no-store')

  if (p.grant_type === 'authorization_code') {
    const { rows } = await query<{
      code: string; client_id: string; redirect_uri: string; code_challenge: string; token_id: string
      access_token: string; scopes: string[]; expired: boolean; used_at: string | null
    }>(`SELECT code, client_id, redirect_uri, code_challenge, token_id, access_token, scopes, expires_at < NOW() AS expired, used_at
          FROM oauth_codes WHERE code = $1`, [p.code ?? ''])
    const row = rows[0]
    if (!row || row.used_at || row.expired) return err(c, 400, 'invalid_grant', 'Unknown, used or expired code')
    if (p.client_id && p.client_id !== row.client_id) return err(c, 400, 'invalid_grant', 'client_id mismatch')
    if (p.redirect_uri && p.redirect_uri !== row.redirect_uri) return err(c, 400, 'invalid_grant', 'redirect_uri mismatch')
    const verifier = p.code_verifier ?? ''
    if (!verifier || !safeEq(b64url(sha256(verifier)), row.code_challenge)) return err(c, 400, 'invalid_grant', 'PKCE verification failed')

    const { rows: grant } = await query<{ consent_grant_id: string; expires_at: string }>(`SELECT consent_grant_id, expires_at FROM data_out_tokens WHERE id = $1`, [row.token_id])
    const refresh = `dwr_${b64url(randomBytes(32))}`
    await query(`UPDATE oauth_codes SET used_at = NOW(), access_token = '' WHERE code = $1`, [row.code])
    await query(`INSERT INTO oauth_refresh_tokens (token_hash, client_id, token_id, consent_grant_id) VALUES ($1, $2, $3, $4)`,
      [hashToken(refresh), row.client_id, row.token_id, grant[0]!.consent_grant_id])
    const expiresIn = Math.max(60, Math.floor((new Date(grant[0]!.expires_at).getTime() - Date.now()) / 1000))
    return c.json({ access_token: row.access_token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh, scope: row.scopes.join(' ') })
  }

  if (p.grant_type === 'refresh_token') {
    const { rows } = await query<{ token_hash: string; client_id: string; token_id: string; consent_grant_id: string; rotated_at: string | null; grant_status: string; consumer_name: string; consumer_type: ConsumerType; allowed_scopes: string[] }>(
      `SELECT r.token_hash, r.client_id, r.token_id, r.consent_grant_id, r.rotated_at, g.status AS grant_status, t.consumer_name, t.consumer_type, t.allowed_scopes
         FROM oauth_refresh_tokens r JOIN consent_grants g ON g.id = r.consent_grant_id JOIN data_out_tokens t ON t.id = r.token_id
        WHERE r.token_hash = $1`, [hashToken(p.refresh_token ?? '')])
    const row = rows[0]
    if (!row || row.rotated_at) return err(c, 400, 'invalid_grant', 'Unknown or already-rotated refresh token')
    if (row.grant_status !== 'ACTIVE') return err(c, 400, 'invalid_grant', 'WALLET_ACCESS_REVOKED: the owner revoked this connection')
    // Rotate: new bearer under the same grant, old bearer retired, old refresh token spent.
    const token = newToken()
    const refresh = `dwr_${b64url(randomBytes(32))}`
    const client = await db().connect()
    try {
      await client.query('BEGIN')
      const t = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO data_out_tokens (tenant_id, user_id, consent_grant_id, consumer_name, consumer_type, token_hash, allowed_scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW() + ($8 || ' days')::interval) RETURNING id, expires_at`,
        [OWNER.tenantId, OWNER.userId, row.consent_grant_id, row.consumer_name, row.consumer_type, hashToken(token), row.allowed_scopes, String(TOKEN_TTL_DAYS)],
      )
      await client.query(`UPDATE data_out_tokens SET is_revoked = TRUE WHERE id = $1`, [row.token_id])
      await client.query(`UPDATE oauth_refresh_tokens SET rotated_at = NOW() WHERE token_hash = $1`, [row.token_hash])
      await client.query(`INSERT INTO oauth_refresh_tokens (token_hash, client_id, token_id, consent_grant_id) VALUES ($1, $2, $3, $4)`,
        [hashToken(refresh), row.client_id, t.rows[0]!.id, row.consent_grant_id])
      await client.query('COMMIT')
      await ledger({ ...OWNER, tokenId: t.rows[0]!.id, consumerName: row.consumer_name, operation: 'TOKEN_REFRESHED', scopesServed: row.allowed_scopes, detail: { previous_token_id: row.token_id } })
      const expiresIn = Math.floor((new Date(t.rows[0]!.expires_at).getTime() - Date.now()) / 1000)
      return c.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh, scope: row.allowed_scopes.join(' ') })
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  return err(c, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
})

export default oauth
