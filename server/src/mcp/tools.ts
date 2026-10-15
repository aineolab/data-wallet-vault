// mcp lane. Tool registrations, filtered by token type (CLAUDE.md "MCP tools").
//   Consumer (AI_AGENT_MCP, DATA_BUYER_API): read-only, two tools, scope enforced by core queryMemories SQL.
//   Owner (OWNER): everything. LinkedIn / offer / ship are thin HTTP calls to the /v1 routes other lanes own.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Auth } from '../auth.js'
import { query } from '../db.js'
import { ledger, readLedger } from '../ledger.js'
import { ALL_SCOPES, RESTRICTED, effectiveScopes, queryMemories, type Scope } from '../scopes.js'

export const CONSUMER_TOOLS = ['wallet_get_identity_card', 'wallet_search_memories'] as const
export const OWNER_TOOLS = [
  'wallet_request_linkedin_export',
  'wallet_archive_ready',
  'wallet_linkedin_drift',
  'wallet_linkedin_apply_drift',
  'wallet_deposit',
  'wallet_job_status',
  'wallet_search',
  'wallet_connections',
  'wallet_revoke',
  'wallet_statement',
  'wallet_offer_to_buyer',
  'wallet_ship',
] as const

export interface ToolContext {
  auth: Auth
  /** Plaintext bearer the caller sent; forwarded to /v1 proxies. */
  bearerToken: string
  /** Origin to reach /v1 on (same deployment as /mcp). */
  v1Base: string
}

const SCOPE_NOTICE = {
  code: 'SCOPE_RESTRICTED',
  message: 'This request is outside the scopes the owner granted to this token. The block has been recorded in the owner’s statement.',
}

const json = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
  isError: isError || undefined,
})

const scopeEnum = z.enum(ALL_SCOPES)

// ---------- consumer tools (read-only) ----------

export function registerConsumerTools(server: McpServer, ctx: ToolContext) {
  const { auth } = ctx
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const

  server.registerTool(
    'wallet_get_identity_card',
    {
      title: 'Identity card',
      description:
        'The owner’s identity card (name, headline, location) and work history. Requires the work_profile scope; otherwise returns a SCOPE_RESTRICTED notice.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const requested: Scope[] = ['work_profile']
      const { served, blocked } = effectiveScopes(requested, auth.scopes)
      if (blocked.length) {
        await ledger({
          tenantId: auth.tenantId,
          userId: auth.userId,
          tokenId: auth.tokenId,
          consumerName: auth.consumerName,
          operation: 'SCOPE_BLOCKED',
          scopesRequested: requested,
          scopesServed: served,
          detail: { tool: 'wallet_get_identity_card' },
        })
      }
      if (!served.length) return json({ identity_card: null, work_history: [], notice: SCOPE_NOTICE })
      const { rows } = await query<{ identity_card: unknown; work_history: unknown[]; updated_at: string }>(
        `SELECT identity_card, work_history, updated_at FROM canonical_profiles WHERE tenant_id = $1 AND user_id = $2`,
        [auth.tenantId, auth.userId],
      )
      const row = rows[0]
      const workHistory = Array.isArray(row?.work_history) ? row.work_history : []
      await ledger({
        tenantId: auth.tenantId,
        userId: auth.userId,
        tokenId: auth.tokenId,
        consumerName: auth.consumerName,
        operation: 'GET_IDENTITY_CARD',
        scopesRequested: requested,
        scopesServed: served,
        recordsReturned: row ? 1 + workHistory.length : 0,
      })
      return json({ identity_card: row?.identity_card ?? null, work_history: workHistory, updated_at: row?.updated_at ?? null })
    },
  )

  server.registerTool(
    'wallet_search_memories',
    {
      title: 'Search memories',
      description:
        'Search the owner’s wallet for facts (with provenance) within the scopes granted to this token. Optional category narrows to one scope; a category outside the grant returns no records plus a SCOPE_RESTRICTED notice.',
      inputSchema: {
        query: z.string().min(1).describe('Substring to look for in the fact text'),
        category: scopeEnum.optional().describe('Restrict to one scope category'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: readOnly,
    },
    async ({ query: q, category, limit }) => searchMemories(ctx, q, category, limit, 'MCP_SEARCH_MEMORIES'),
  )
}

async function searchMemories(
  ctx: ToolContext,
  q: string | undefined,
  category: Scope | undefined,
  limit: number | undefined,
  operation: 'MCP_SEARCH_MEMORIES' | 'MEMORIES_QUERY',
): Promise<CallToolResult> {
  const { auth } = ctx
  const requested = category ? [category] : undefined
  const { served, blocked } = effectiveScopes(requested, auth.scopes)
  if (blocked.length) {
    await ledger({
      tenantId: auth.tenantId,
      userId: auth.userId,
      tokenId: auth.tokenId,
      consumerName: auth.consumerName,
      operation: 'SCOPE_BLOCKED',
      scopesRequested: requested ?? [],
      scopesServed: served,
      detail: { query: q ?? null, blocked },
    })
  }
  if (!served.length) return json({ records: [], notice: SCOPE_NOTICE })
  const records = await queryMemories({ tenantId: auth.tenantId, userId: auth.userId, scopes: served, q, limit })
  await ledger({
    tenantId: auth.tenantId,
    userId: auth.userId,
    tokenId: auth.tokenId,
    consumerName: auth.consumerName,
    operation,
    scopesRequested: requested ?? served,
    scopesServed: served,
    recordsReturned: records.length,
    detail: { query: q ?? null },
  })
  return json({
    records: records.map((r) => ({ fact: r.fact, category: r.category, provenance: r.provenance, confidence: r.confidence })),
    ...(blocked.length ? { notice: SCOPE_NOTICE } : {}),
  })
}

// ---------- owner tools ----------

/** Thin call to a /v1 route another lane owns, forwarding the owner's bearer. 404 -> clear "not available yet". */
async function v1(ctx: ToolContext, method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallToolResult> {
  const url = `${ctx.v1Base}/v1${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${ctx.bearerToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    return json({ error: 'V1_UNREACHABLE', message: `Could not reach ${url}: ${(err as Error).message}` }, true)
  }
  const text = await res.text()
  let data: unknown = text
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    /* non-JSON body: keep text */
  }
  if (res.status === 404 && (typeof data !== 'object' || (data as { error?: string })?.error === 'not_found')) {
    return json(
      { error: 'NOT_AVAILABLE_YET', message: `${method} /v1${path} is not deployed on this server yet (lane still landing).` },
      true,
    )
  }
  if (!res.ok) return json({ http_status: res.status, ...(typeof data === 'object' && data ? data : { body: data }) }, true)
  return json(data)
}

export function registerOwnerTools(server: McpServer, ctx: ToolContext) {
  const { auth } = ctx
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const
  const mutating = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const

  server.registerTool(
    'wallet_search',
    {
      title: 'Search my wallet (owner)',
      description: 'Owner search across every scope the owner token carries, including health_finance_restricted when granted.',
      inputSchema: {
        query: z.string().optional().describe('Substring to look for; empty = newest facts'),
        category: scopeEnum.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: readOnly,
    },
    async ({ query: q, category, limit }) => searchMemories(ctx, q, category, limit, 'MEMORIES_QUERY'),
  )

  server.registerTool(
    'wallet_connections',
    {
      title: 'Connected agents',
      description: 'Every token issued on this wallet: who holds it, its scopes, expiry, and whether it is revoked.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const { rows } = await query(
        `SELECT t.id AS token_id, t.consumer_name, t.consumer_type, t.allowed_scopes, t.expires_at, t.is_revoked,
                t.created_at, g.id AS grant_id, g.status AS grant_status, g.exclusive
           FROM data_out_tokens t JOIN consent_grants g ON g.id = t.consent_grant_id
          WHERE t.tenant_id = $1 AND t.user_id = $2
          ORDER BY t.created_at DESC`,
        [auth.tenantId, auth.userId],
      )
      return json({ connections: rows })
    },
  )

  server.registerTool(
    'wallet_revoke',
    {
      title: 'Revoke an agent',
      description:
        'Kill switch: revoke a token by token_id. Its grant becomes REVOKED, and the agent’s next call fails with WALLET_ACCESS_REVOKED. Recorded in the statement.',
      inputSchema: { token_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ token_id }) => {
      const { rows } = await query<{ id: string; consent_grant_id: string; consumer_name: string; is_revoked: boolean }>(
        `UPDATE data_out_tokens SET is_revoked = TRUE
          WHERE id = $1 AND tenant_id = $2 AND user_id = $3
          RETURNING id, consent_grant_id, consumer_name, is_revoked`,
        [token_id, auth.tenantId, auth.userId],
      )
      const t = rows[0]
      if (!t) return json({ error: 'NOT_FOUND', message: `No token ${token_id} on this wallet` }, true)
      await query(
        `UPDATE consent_grants SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, NOW())
          WHERE id = $1 AND status <> 'REVOKED'`,
        [t.consent_grant_id],
      )
      await ledger({
        tenantId: auth.tenantId,
        userId: auth.userId,
        tokenId: auth.tokenId,
        consumerName: auth.consumerName,
        operation: 'TOKEN_REVOKED',
        detail: { revoked_token_id: t.id, revoked_consumer: t.consumer_name, grant_id: t.consent_grant_id },
      })
      return json({ revoked: true, token_id: t.id, consumer_name: t.consumer_name, grant_id: t.consent_grant_id })
    },
  )

  server.registerTool(
    'wallet_statement',
    {
      title: 'Statement',
      description: 'The last 50 ledger entries: every read, block, revoke and ship, with who did it and which scopes were served.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: readOnly,
    },
    async ({ limit }) => json({ entries: await readLedger(auth.tenantId, auth.userId, limit ?? 50) }),
  )

  server.registerTool(
    'wallet_job_status',
    {
      title: 'Import job status',
      description: 'Status of data-in jobs (LinkedIn export, deposits). With job_id, includes the full event history.',
      inputSchema: { job_id: z.string().uuid().optional() },
      annotations: readOnly,
    },
    async ({ job_id }) => {
      if (job_id) {
        const job = await query(
          `SELECT id, provider, archive_kind, state, external_ref, ready_hint_at, archive_expires_at, attempts, last_error,
                  next_check_at, created_at, updated_at
             FROM source_jobs WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
          [job_id, auth.tenantId, auth.userId],
        )
        if (!job.rows[0]) return json({ error: 'NOT_FOUND', message: `No job ${job_id}` }, true)
        const events = await query(
          `SELECT from_state, to_state, note, created_at FROM source_job_events WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
          [job_id],
        )
        return json({ job: job.rows[0], events: events.rows })
      }
      const { rows } = await query(
        `SELECT id, provider, archive_kind, state, attempts, last_error, created_at, updated_at
           FROM source_jobs WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`,
        [auth.tenantId, auth.userId],
      )
      return json({ jobs: rows })
    },
  )

  // ----- proxies to /v1 routes owned by the linkedin and wallet-api lanes -----

  server.registerTool(
    'wallet_request_linkedin_export',
    {
      title: 'Request LinkedIn export',
      description:
        'Start the LinkedIn GDPR export flow: creates the DATA_IN grant and job, and returns the LinkedIn deep link plus two-line instructions for the human. The wallet never automates LinkedIn.',
      inputSchema: {
        archive_kind: z.enum(['fast', 'full']).default('fast'),
        mock_delay_s: z.number().int().min(0).optional().describe('Mock only: seconds until the archive is "ready"'),
      },
      annotations: mutating,
    },
    async (args) => v1(ctx, 'POST', '/sources/linkedin/request', args),
  )

  server.registerTool(
    'wallet_archive_ready',
    {
      title: 'LinkedIn archive is ready',
      description:
        'Tell the wallet LinkedIn’s "your data is ready" email arrived (the owner’s agent watches the inbox; the wallet never does). Moves the job to ARCHIVE_READY.',
      inputSchema: { job_id: z.string().uuid() },
      annotations: mutating,
    },
    async ({ job_id }) => v1(ctx, 'POST', `/jobs/${job_id}/archive-ready`, {}),
  )

  server.registerTool(
    'wallet_deposit',
    {
      title: 'Deposit an export',
      description:
        'Deposit a downloaded export into the wallet for a job (the LinkedIn zip, or a chat export). Pass the job_id; for the mock provider the archive is picked up server-side. A direct file upload goes to POST /v1/ingest.',
      inputSchema: {
        job_id: z.string().uuid().optional(),
        source_url: z.string().url().optional().describe('Where the server can fetch the export from (optional)'),
      },
      annotations: mutating,
    },
    async (args) => v1(ctx, 'POST', '/ingest', args),
  )

  server.registerTool(
    'wallet_linkedin_drift',
    {
      title: 'LinkedIn drift check',
      description:
        'Compare the wallet with the live LinkedIn snapshot (or a fresh archive) and report added / removed / changed per domain. Changes nothing; writes a LINKEDIN_DRIFT_CHECK ledger row.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => v1(ctx, 'POST', '/sources/linkedin/drift', {}),
  )

  server.registerTool(
    'wallet_linkedin_apply_drift',
    {
      title: 'Apply LinkedIn drift',
      description: 'Apply the last drift check to the wallet after the owner says yes.',
      inputSchema: {},
      annotations: mutating,
    },
    async () => v1(ctx, 'POST', '/sources/linkedin/apply-drift', {}),
  )

  server.registerTool(
    'wallet_offer_to_buyer',
    {
      title: 'Offer data to a buyer',
      description:
        'Issue a DATA_BUYER_API token for a buyer on the given scopes. exclusive=true means that after shipping, the wallet refuses any further grant on those scopes (RESALE_BLOCKED).',
      inputSchema: {
        buyer_name: z.string().min(1),
        scopes: z.array(scopeEnum).min(1),
        exclusive: z.boolean().default(false),
      },
      annotations: mutating,
    },
    async ({ buyer_name, scopes, exclusive }) => {
      if (scopes.includes(RESTRICTED))
        return json({ error: 'SCOPE_RESTRICTED', message: `${RESTRICTED} is never offered to buyers.` }, true)
      return v1(ctx, 'POST', '/tokens/issue', { consumer_name: buyer_name, consumer_type: 'DATA_BUYER_API', scopes, exclusive })
    },
  )

  server.registerTool(
    'wallet_ship',
    {
      title: 'Ship data to a buyer',
      description:
        'Ship the data under a grant to its buyer: signed URL to the buyer, wallet copy shredded, grant marked SHIPPED, DATA_SHIPPED ledger row.',
      inputSchema: { grant_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ grant_id }) => v1(ctx, 'POST', '/ship', { grant_id }),
  )
}
