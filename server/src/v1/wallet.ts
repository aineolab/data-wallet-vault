// wallet-api lane. Routes (CLAUDE.md "Internal REST"): POST /tokens/issue, POST /memories/query, GET /profile,
// DELETE /tokens/:id, POST /ship, GET /ledger, GET /connections. Uses core: auth.ts, scopes.ts, ledger.ts.
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import { hashToken, newToken, requireOwner, requireToken, type ConsumerType } from '../auth.js'
import { config } from '../config.js'
import { query } from '../db.js'
import { ledger, readLedger } from '../ledger.js'
import { ALL_SCOPES, RESTRICTED, effectiveScopes, isScope, queryMemories, type Scope } from '../scopes.js'

const wallet = new Hono()

const CONSUMER_TYPES: ConsumerType[] = ['OWNER', 'DATA_IN_AGENT', 'AI_AGENT_MCP', 'DATA_BUYER_API']
const TOKEN_TTL_DAYS = 30

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------------------------------------------
// POST /tokens/issue  (owner)  {consumer_name, consumer_type, scopes[], exclusive?} -> {token, token_id, grant_id}
// ---------------------------------------------------------------------------------------------------------------
wallet.post('/tokens/issue', requireOwner, async (c) => {
  const auth = c.get('auth')
  const body = await readJson(c)
  const consumerName = typeof body.consumer_name === 'string' ? body.consumer_name.trim() : ''
  const consumerType = body.consumer_type as ConsumerType
  const exclusive = body.exclusive === true
  const rawScopes = Array.isArray(body.scopes) ? body.scopes : []

  if (!consumerName) return c.json({ error: 'invalid_request', message: 'consumer_name is required' }, 400)
  if (!CONSUMER_TYPES.includes(consumerType))
    return c.json({ error: 'invalid_request', message: `consumer_type must be one of ${CONSUMER_TYPES.join(', ')}` }, 400)
  const unknown = rawScopes.filter((s) => !isScope(s))
  if (unknown.length)
    return c.json({ error: 'invalid_scope', message: `Unknown scopes: ${unknown.join(', ')}`, allowed: ALL_SCOPES }, 400)
  // Restricted only when explicitly listed (non-negotiable 2). Never implied, never defaulted.
  const scopes = [...new Set(rawScopes.filter(isScope))] as Scope[]
  if (!scopes.length) return c.json({ error: 'invalid_scope', message: 'scopes must list at least one scope' }, 400)

  // RESALE GUARD: a shipped exclusive grant to someone else that covers any requested scope blocks this issue.
  const { rows: shipped } = await query<{ id: string; counterparty: string; allowed_scopes: string[] }>(
    `SELECT id, counterparty, allowed_scopes FROM consent_grants
      WHERE tenant_id = $1 AND user_id = $2 AND direction = 'DATA_OUT'
        AND status = 'SHIPPED' AND exclusive = TRUE
        AND counterparty <> $3 AND allowed_scopes && $4::text[]`,
    [auth.tenantId, auth.userId, consumerName, scopes],
  )
  if (shipped.length) {
    const shippedTo = [...new Set(shipped.map((g) => g.counterparty))]
    const covered = [...new Set(shipped.flatMap((g) => g.allowed_scopes.filter((s) => scopes.includes(s as Scope))))]
    await ledger({
      tenantId: auth.tenantId,
      userId: auth.userId,
      tokenId: auth.tokenId,
      consumerName,
      operation: 'RESALE_BLOCKED',
      scopesRequested: scopes,
      scopesServed: [],
      detail: { shipped_grant_ids: shipped.map((g) => g.id), shipped_to: shippedTo, covered },
    })
    return c.json(
      {
        error: 'RESALE_BLOCKED',
        message: `Scopes ${covered.join(', ')} were shipped exclusively to ${shipped[0]!.counterparty}; the wallet refuses resale`,
        covered_scopes: covered,
        shipped_to: shippedTo,
      },
      409,
    )
  }

  const token = newToken()
  const { rows: grants } = await query<{ id: string }>(
    `INSERT INTO consent_grants (tenant_id, user_id, direction, counterparty, allowed_scopes, exclusive, status)
     VALUES ($1, $2, 'DATA_OUT', $3, $4::text[], $5, 'ACTIVE') RETURNING id`,
    [auth.tenantId, auth.userId, consumerName, scopes, exclusive],
  )
  const grantId = grants[0]!.id
  const { rows: tokens } = await query<{ id: string; expires_at: string }>(
    `INSERT INTO data_out_tokens
       (tenant_id, user_id, consent_grant_id, consumer_name, consumer_type, token_hash, allowed_scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW() + ($8 || ' days')::interval)
     RETURNING id, expires_at`,
    [auth.tenantId, auth.userId, grantId, consumerName, consumerType, hashToken(token), scopes, String(TOKEN_TTL_DAYS)],
  )
  const tokenId = tokens[0]!.id
  await ledger({
    tenantId: auth.tenantId,
    userId: auth.userId,
    tokenId,
    consumerName,
    operation: 'TOKEN_ISSUED',
    scopesRequested: scopes,
    scopesServed: scopes,
    detail: { consumer_type: consumerType, exclusive, grant_id: grantId, restricted: scopes.includes(RESTRICTED) },
  })
  return c.json({ token, token_id: tokenId, grant_id: grantId, scopes, exclusive, expires_at: tokens[0]!.expires_at })
})

// ---------------------------------------------------------------------------------------------------------------
// POST /memories/query  (any token)  {query, category?, limit?} -> {records:[{fact, category, provenance}], notice?}
// ---------------------------------------------------------------------------------------------------------------
wallet.post('/memories/query', requireToken, async (c) => {
  const auth = c.get('auth')
  const body = await readJson(c)
  const q = typeof body.query === 'string' ? body.query : ''
  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : undefined
  const limit = typeof body.limit === 'number' ? body.limit : undefined

  // An unknown category name is still a request outside the token: block it, don't silently widen to "all".
  const requested = category ? [category] : undefined
  const { served, blocked: blockedKnown } = effectiveScopes(requested, auth.scopes)
  const blocked = category && !isScope(category) ? [category] : blockedKnown

  const rows = served.length
    ? await queryMemories({ tenantId: auth.tenantId, userId: auth.userId, scopes: served, q, limit })
    : []
  const records = rows.map((r) => ({ fact: r.fact, category: r.category, provenance: r.provenance }))

  if (blocked.length) {
    await ledger({
      tenantId: auth.tenantId,
      userId: auth.userId,
      tokenId: auth.tokenId,
      consumerName: auth.consumerName,
      operation: 'SCOPE_BLOCKED',
      scopesRequested: requested ?? [...served, ...blocked],
      scopesServed: served,
      recordsReturned: records.length,
      detail: { blocked, query: q.slice(0, 200) },
    })
  }
  if (served.length) {
    await ledger({
      tenantId: auth.tenantId,
      userId: auth.userId,
      tokenId: auth.tokenId,
      consumerName: auth.consumerName,
      operation: 'MEMORIES_QUERY',
      scopesRequested: requested ?? served,
      scopesServed: served,
      recordsReturned: records.length,
      detail: { query: q.slice(0, 200) },
    })
  }
  return c.json(
    blocked.length
      ? { records, notice: 'SCOPE_RESTRICTED', blocked_scopes: blocked, served_scopes: served }
      : { records, served_scopes: served },
  )
})

// ---------------------------------------------------------------------------------------------------------------
// GET /profile  (any token)  -> {identity_card, work_history} when the token has work_profile
// ---------------------------------------------------------------------------------------------------------------
wallet.get('/profile', requireToken, async (c) => {
  const auth = c.get('auth')
  const { served, blocked } = effectiveScopes(['work_profile'], auth.scopes)
  if (blocked.length || !served.length) {
    await ledger({
      tenantId: auth.tenantId,
      userId: auth.userId,
      tokenId: auth.tokenId,
      consumerName: auth.consumerName,
      operation: 'SCOPE_BLOCKED',
      scopesRequested: ['work_profile'],
      scopesServed: [],
      detail: { route: 'GET /v1/profile' },
    })
    return c.json({ notice: 'SCOPE_RESTRICTED', blocked_scopes: ['work_profile'] })
  }
  const { rows } = await query<{ identity_card: unknown; work_history: unknown; updated_at: string }>(
    `SELECT identity_card, work_history, updated_at FROM canonical_profiles WHERE tenant_id = $1 AND user_id = $2`,
    [auth.tenantId, auth.userId],
  )
  const p = rows[0]
  await ledger({
    tenantId: auth.tenantId,
    userId: auth.userId,
    tokenId: auth.tokenId,
    consumerName: auth.consumerName,
    operation: 'GET_IDENTITY_CARD',
    scopesRequested: ['work_profile'],
    scopesServed: ['work_profile'],
    recordsReturned: p ? 1 : 0,
  })
  return c.json({ identity_card: p?.identity_card ?? {}, work_history: p?.work_history ?? [], updated_at: p?.updated_at ?? null })
})

// ---------------------------------------------------------------------------------------------------------------
// DELETE /tokens/:id  (owner)  kill switch. The next call with that token gets 401 WALLET_ACCESS_REVOKED.
// ---------------------------------------------------------------------------------------------------------------
wallet.delete('/tokens/:id', requireOwner, async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: 'invalid_request', message: 'token id must be a UUID' }, 400)
  const { rows } = await query<{ id: string; consent_grant_id: string; consumer_name: string; allowed_scopes: string[]; is_revoked: boolean }>(
    `UPDATE data_out_tokens SET is_revoked = TRUE
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      RETURNING id, consent_grant_id, consumer_name, allowed_scopes, is_revoked`,
    [id, auth.tenantId, auth.userId],
  )
  const t = rows[0]
  if (!t) return c.json({ error: 'not_found', message: 'No such token' }, 404)
  // consent_guard allows only status/revoked_at to change. A SHIPPED grant stays SHIPPED (the resale guard needs it).
  await query(
    `UPDATE consent_grants SET status = 'REVOKED', revoked_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND status = 'ACTIVE'`,
    [t.consent_grant_id, auth.tenantId, auth.userId],
  )
  await ledger({
    tenantId: auth.tenantId,
    userId: auth.userId,
    tokenId: t.id,
    consumerName: t.consumer_name,
    operation: 'TOKEN_REVOKED',
    scopesRequested: t.allowed_scopes,
    scopesServed: [],
    detail: { grant_id: t.consent_grant_id, revoked_by: auth.consumerName },
  })
  return c.json({ revoked: true, token_id: t.id, grant_id: t.consent_grant_id, consumer_name: t.consumer_name })
})

// ---------------------------------------------------------------------------------------------------------------
// POST /ship  (owner)  {grant_id} -> grant SHIPPED, covered raw files SHREDDED + Storage objects deleted
// ---------------------------------------------------------------------------------------------------------------
async function deleteStorageObjects(uris: string[]): Promise<{ deleted: string[]; skipped: string[] }> {
  const cfg = config()
  const deleted: string[] = []
  const skipped: string[] = []
  // Only objects in the `vault` bucket are ours to delete; seed:// and file:// URIs have nothing in Storage.
  // Accepted forms: supabase://vault/<path>, storage://vault/<path>, vault/<path>, <SUPABASE_URL>/storage/v1/object/.../vault/<path>.
  const paths: { u: string; path: string }[] = []
  for (const u of uris) {
    const m = /^(?:seed|file):\/\//.test(u) ? null : /(?:^|\/)vault\/(.+)$/.exec(u)
    if (m?.[1]) paths.push({ u, path: m[1] })
    else skipped.push(u)
  }
  if (!paths.length) return { deleted, skipped }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
    skipped.push(...paths.map((p) => p.u))
    return { deleted, skipped }
  }
  const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { error } = await sb.storage.from('vault').remove(paths.map((p) => p.path))
  if (error) {
    console.error('ship: storage remove failed', error.message)
    skipped.push(...paths.map((p) => p.u))
  } else deleted.push(...paths.map((p) => p.u))
  return { deleted, skipped }
}

wallet.post('/ship', requireOwner, async (c) => {
  const auth = c.get('auth')
  const body = await readJson(c)
  const grantId = typeof body.grant_id === 'string' ? body.grant_id : ''
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) return c.json({ error: 'invalid_request', message: 'grant_id must be a UUID' }, 400)

  const { rows: grants } = await query<{ id: string; counterparty: string; allowed_scopes: string[]; exclusive: boolean; status: string }>(
    `SELECT id, counterparty, allowed_scopes, exclusive, status FROM consent_grants
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND direction = 'DATA_OUT'`,
    [grantId, auth.tenantId, auth.userId],
  )
  const g = grants[0]
  if (!g) return c.json({ error: 'not_found', message: 'No such DATA_OUT grant' }, 404)
  if (g.status === 'REVOKED' || g.status === 'EXPIRED')
    return c.json({ error: 'grant_not_active', message: `Grant is ${g.status}; cannot ship` }, 409)

  if (g.status !== 'SHIPPED') {
    await query(`UPDATE consent_grants SET status = 'SHIPPED' WHERE id = $1`, [g.id])
  }
  const { rows: files } = await query<{ id: string; storage_uri: string }>(
    `UPDATE raw_vault_files SET sync_status = 'SHREDDED'
      WHERE consent_grant_id = $1 AND tenant_id = $2 AND user_id = $3 AND sync_status <> 'SHREDDED'
      RETURNING id, storage_uri`,
    [g.id, auth.tenantId, auth.userId],
  )
  const storage = await deleteStorageObjects(files.map((f) => f.storage_uri))

  await ledger({
    tenantId: auth.tenantId,
    userId: auth.userId,
    tokenId: auth.tokenId,
    consumerName: g.counterparty,
    operation: 'DATA_SHIPPED',
    scopesRequested: g.allowed_scopes,
    scopesServed: g.allowed_scopes,
    recordsReturned: files.length,
    detail: { grant_id: g.id, exclusive: g.exclusive, shredded_files: files.map((f) => f.id), storage },
  })
  return c.json({
    shipped: true,
    grant_id: g.id,
    counterparty: g.counterparty,
    exclusive: g.exclusive,
    scopes: g.allowed_scopes,
    signed_url: null,
    shredded_files: files.length,
    already_shipped: g.status === 'SHIPPED',
  })
})

// ---------------------------------------------------------------------------------------------------------------
// GET /ledger  (owner)  -> {entries:[...]}        GET /connections (owner) -> {connections:[...]}
// ---------------------------------------------------------------------------------------------------------------
wallet.get('/ledger', requireOwner, async (c) => {
  const auth = c.get('auth')
  const limit = Number(c.req.query('limit') ?? 200)
  const entries = await readLedger(auth.tenantId, auth.userId, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200)
  return c.json({ entries })
})

wallet.get('/connections', requireOwner, async (c) => {
  const auth = c.get('auth')
  const { rows } = await query<{
    token_id: string
    consumer_name: string
    consumer_type: ConsumerType
    allowed_scopes: string[]
    expires_at: string
    is_revoked: boolean
    exclusive: boolean
    grant_id: string
    grant_status: string
    created_at: string
  }>(
    `SELECT t.id AS token_id, t.consumer_name, t.consumer_type, t.allowed_scopes, t.expires_at,
            (t.is_revoked OR g.status = 'REVOKED') AS is_revoked, g.exclusive, g.id AS grant_id, g.status AS grant_status,
            t.created_at
       FROM data_out_tokens t JOIN consent_grants g ON g.id = t.consent_grant_id
      WHERE t.tenant_id = $1 AND t.user_id = $2
      ORDER BY t.created_at DESC`,
    [auth.tenantId, auth.userId],
  )
  return c.json({ connections: rows })
})

export default wallet
