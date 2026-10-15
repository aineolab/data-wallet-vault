// Core: append-only egress ledger (non-negotiable 5). Every read, block, revoke and ship writes a row.
// The table's trigger blocks UPDATE/DELETE, so this module only ever inserts.
import { query } from './db.js'

export type LedgerOperation =
  | 'MCP_SEARCH_MEMORIES'
  | 'GET_IDENTITY_CARD'
  | 'MEMORIES_QUERY'
  | 'SCOPE_BLOCKED'
  | 'TOKEN_ISSUED'
  | 'TOKEN_REVOKED'
  | 'DATA_SHIPPED'
  | 'RESALE_BLOCKED'
  | 'FACTS_INGESTED'
  | 'LINKEDIN_DRIFT_CHECK'
  | 'EXPOSURE_SCAN'
  | (string & {})

export interface LedgerEntry {
  tenantId: string
  userId: string
  tokenId?: string | null
  consumerName: string
  operation: LedgerOperation
  scopesRequested?: readonly string[]
  scopesServed?: readonly string[]
  recordsReturned?: number
  detail?: Record<string, unknown>
}

export async function ledger(e: LedgerEntry): Promise<void> {
  await query(
    `INSERT INTO egress_ledger
       (tenant_id, user_id, token_id, consumer_name, operation, scopes_requested, scopes_served, records_returned, detail)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9::jsonb)`,
    [
      e.tenantId,
      e.userId,
      e.tokenId ?? null,
      e.consumerName,
      e.operation,
      e.scopesRequested ?? [],
      e.scopesServed ?? [],
      e.recordsReturned ?? 0,
      JSON.stringify(e.detail ?? {}),
    ],
  )
}

export interface LedgerRow {
  created_at: string
  consumer_name: string
  operation: string
  scopes_requested: string[]
  scopes_served: string[]
  records_returned: number
}

/** Shape of GET /v1/ledger entries (the Lovable dashboard reads exactly this). */
export async function readLedger(tenantId: string, userId: string, limit = 200): Promise<LedgerRow[]> {
  const { rows } = await query<LedgerRow>(
    `SELECT created_at, consumer_name, operation, scopes_requested, scopes_served, records_returned
       FROM egress_ledger WHERE tenant_id = $1 AND user_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, userId, limit],
  )
  return rows
}
