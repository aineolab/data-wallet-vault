// Core: scope enforcement in SQL (non-negotiables 1 and 2). Never trust a model or a caller to filter.
import { query } from './db.js'

export const ALL_SCOPES = [
  'work_profile',
  'coding_preferences',
  'shopping_preferences',
  'personal_memory',
  'health_finance_restricted',
] as const
export type Scope = (typeof ALL_SCOPES)[number]
export const RESTRICTED: Scope = 'health_finance_restricted'
/** What a consent page / token issue offers by default. Restricted is never in here. */
export const DEFAULT_SCOPES: Scope[] = ALL_SCOPES.filter((s) => s !== RESTRICTED)

export const isScope = (s: unknown): s is Scope => typeof s === 'string' && (ALL_SCOPES as readonly string[]).includes(s)

/**
 * Scopes a request may actually be served from. `requested` empty = everything the token allows.
 * Restricted is served only when the token carries it explicitly, never implied by "all".
 */
export function effectiveScopes(requested: readonly string[] | undefined, allowed: readonly Scope[]): {
  served: Scope[]
  blocked: Scope[]
} {
  const want = requested && requested.length ? requested.filter(isScope) : allowed.filter((s) => s !== RESTRICTED)
  const served = want.filter((s) => allowed.includes(s))
  const blocked = want.filter((s) => !allowed.includes(s))
  return { served, blocked }
}

export interface MemoryRecord {
  id: string
  fact: string
  category: Scope
  provenance: string
  confidence: number
  source_provider: string
}

/**
 * THE scope filter. `scope_category = ANY($scopes) AND is_quarantined = FALSE` is in the SQL, so a request that
 * asks for a category outside `scopes` returns nothing from it, whatever the caller or a model says.
 * `q` is a plain substring match on the fact text (pgvector search is roadmap).
 */
export async function queryMemories(opts: {
  tenantId: string
  userId: string
  scopes: readonly Scope[]
  q?: string
  limit?: number
}): Promise<MemoryRecord[]> {
  if (!opts.scopes.length) return []
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const { rows } = await query<MemoryRecord>(
    `SELECT id, fact_assertion AS fact, scope_category AS category, source_provenance_ref AS provenance,
            confidence_score::float AS confidence, source_provider
       FROM canonical_memories
      WHERE tenant_id = $1 AND user_id = $2
        AND scope_category = ANY($3::text[])
        AND is_quarantined = FALSE
        AND ($4::text IS NULL OR fact_assertion ILIKE '%' || $4 || '%')
      ORDER BY confidence_score DESC, extracted_at ASC
      LIMIT $5`,
    [opts.tenantId, opts.userId, opts.scopes, opts.q?.trim() || null, limit],
  )
  return rows
}
