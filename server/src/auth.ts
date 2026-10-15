// Core: bearer token -> token row. Every check hits Postgres (non-negotiable 6: no caching, revoke is immediate).
// Owner endpoints run in demo mode today: a call with NO Authorization header is the owner (the evals send none;
// CLAUDE.md: "the owner's own login is OWNER_PASSPHRASE for today, real auth is roadmap"). A header that is
// present must be a valid token of the right type.
import { createHash, randomBytes } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { query } from './db.js'
import { ALL_SCOPES, type Scope } from './scopes.js'

// Single-user self-host tenant/user seeded by 20261015000001_init.sql.
export const OWNER = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
} as const

export type ConsumerType = 'OWNER' | 'DATA_IN_AGENT' | 'AI_AGENT_MCP' | 'DATA_BUYER_API'

export interface Auth {
  tenantId: string
  userId: string
  /** null in demo mode (no header) */
  tokenId: string | null
  grantId: string | null
  consumerName: string
  consumerType: ConsumerType
  scopes: Scope[]
  exclusive: boolean
}

export type AuthFailure = { status: 401 | 403; error: string; message: string }

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
/** Plaintext bearer token. Shown once; only its sha256 is stored. */
export const newToken = () => `dw_${randomBytes(32).toString('base64url')}`

export function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m?.[1]?.trim() || null
}

interface TokenRow {
  id: string
  tenant_id: string
  user_id: string
  consent_grant_id: string
  consumer_name: string
  consumer_type: ConsumerType
  allowed_scopes: string[]
  expires_at: string
  is_revoked: boolean
  grant_status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'SHIPPED'
  exclusive: boolean
}

/** Resolve a bearer token against the DB. Never cached. */
export async function resolveToken(token: string): Promise<Auth | AuthFailure> {
  const { rows } = await query<TokenRow>(
    `SELECT t.id, t.tenant_id, t.user_id, t.consent_grant_id, t.consumer_name, t.consumer_type,
            t.allowed_scopes, t.expires_at, t.is_revoked, g.status AS grant_status, g.exclusive
       FROM data_out_tokens t JOIN consent_grants g ON g.id = t.consent_grant_id
      WHERE t.token_hash = $1`,
    [hashToken(token)],
  )
  const r = rows[0]
  if (!r) return { status: 401, error: 'WALLET_INVALID_TOKEN', message: 'Unknown token' }
  if (r.is_revoked || r.grant_status === 'REVOKED')
    return { status: 401, error: 'WALLET_ACCESS_REVOKED', message: 'This token has been revoked by the owner' }
  if (new Date(r.expires_at) < new Date() || r.grant_status === 'EXPIRED')
    return { status: 401, error: 'WALLET_TOKEN_EXPIRED', message: 'This token has expired' }
  return {
    tenantId: r.tenant_id,
    userId: r.user_id,
    tokenId: r.id,
    grantId: r.consent_grant_id,
    consumerName: r.consumer_name,
    consumerType: r.consumer_type,
    scopes: r.allowed_scopes.filter((s): s is Scope => (ALL_SCOPES as readonly string[]).includes(s)),
    exclusive: r.exclusive,
  }
}

export const isFailure = (a: Auth | AuthFailure): a is AuthFailure => 'status' in a

const demoOwner = (): Auth => ({
  ...OWNER,
  tokenId: null,
  grantId: null,
  consumerName: 'owner',
  consumerType: 'OWNER',
  scopes: [...ALL_SCOPES],
  exclusive: false,
})

declare module 'hono' {
  interface ContextVariableMap {
    auth: Auth
  }
}

/** Any valid token (consumer or owner). 401 without one. */
export const requireToken: MiddlewareHandler = async (c, next) => {
  const token = bearer(c)
  if (!token) return c.json({ error: 'unauthorized', message: 'Bearer token required' }, 401)
  const auth = await resolveToken(token)
  if (isFailure(auth)) return c.json({ error: auth.error, message: auth.message }, auth.status)
  c.set('auth', auth)
  await next()
}

/** Owner-only. No header = demo owner. A header must be a valid OWNER token. */
export const requireOwner: MiddlewareHandler = async (c, next) => {
  const token = bearer(c)
  if (!token) {
    c.set('auth', demoOwner())
    return next()
  }
  const auth = await resolveToken(token)
  if (isFailure(auth)) return c.json({ error: auth.error, message: auth.message }, auth.status)
  if (auth.consumerType !== 'OWNER') return c.json({ error: 'OWNER_ONLY', message: 'This endpoint is owner-only' }, 403)
  c.set('auth', auth)
  await next()
}

/** DATA_IN agents (normalizer, importers) or the owner. */
export const requireDataIn: MiddlewareHandler = async (c, next) => {
  const token = bearer(c)
  if (!token) {
    c.set('auth', demoOwner())
    return next()
  }
  const auth = await resolveToken(token)
  if (isFailure(auth)) return c.json({ error: auth.error, message: auth.message }, auth.status)
  if (auth.consumerType !== 'DATA_IN_AGENT' && auth.consumerType !== 'OWNER')
    return c.json({ error: 'DATA_IN_ONLY', message: 'This endpoint takes a DATA_IN or owner token' }, 403)
  c.set('auth', auth)
  await next()
}
