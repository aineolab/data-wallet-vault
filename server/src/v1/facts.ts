// normalizer lane (feature 6). POST /facts: DATA_IN agents (or the owner) deposit distilled facts.
// Every fact is scrubbed (src/scrub.ts); a fact that holds a secret is never stored, not even redacted
// (non-negotiable 3). No provenance -> no row (non-negotiable 4). One FACTS_INGESTED ledger row per call.
import { Hono } from 'hono'
import { requireDataIn } from '../auth.js'
import { db, query } from '../db.js'
import { ledger } from '../ledger.js'
import { isScope, type Scope } from '../scopes.js'
import { containsSecret, scrub } from '../scrub.js'

const facts = new Hono()

type Modality = 'text' | 'image' | 'audio' | 'video' | 'trace'
const MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'video', 'trace']
type SourceType = 'CHATGPT_EXPORT' | 'CLAUDE_EXPORT' | 'GDPR_ARCHIVE' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'COMPUTER_USE_TRACE'
const SOURCE_TYPES: readonly SourceType[] = [
  'CHATGPT_EXPORT',
  'CLAUDE_EXPORT',
  'GDPR_ARCHIVE',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'COMPUTER_USE_TRACE',
]
const MAX_FACTS = 500
const MAX_FACT_LEN = 1000

interface FactIn {
  fact?: unknown
  category?: unknown
  confidence?: unknown
  provenance?: unknown
  raw_file_id?: unknown
  modality?: unknown
}

interface SourceIn {
  kind?: unknown
  sha256?: unknown
  storage_uri?: unknown
  modality?: unknown
}

interface Body {
  facts: FactIn[]
  source?: SourceIn
  source_provider?: string
  raw_file_id?: string
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

function parseBody(raw: unknown): Body | { error: string } {
  if (Array.isArray(raw)) return { facts: raw as FactIn[] }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const list = o.facts ?? []
    if (!Array.isArray(list)) return { error: '`facts` must be an array' }
    return {
      facts: list as FactIn[],
      source: o.source && typeof o.source === 'object' ? (o.source as SourceIn) : undefined,
      source_provider: typeof o.source_provider === 'string' ? o.source_provider : undefined,
      raw_file_id: typeof o.raw_file_id === 'string' ? o.raw_file_id : undefined,
    }
  }
  return { error: 'body must be an array of facts or {facts:[...]}' }
}

/**
 * `source` convenience: a hosted agent has no DB access, so it describes the export it read and the wallet
 * upserts the raw_vault_files row for it under a DATA_IN grant (counterparty 'normalizer'). Idempotent on sha256.
 */
async function ensureRawFile(
  auth: { tenantId: string; userId: string; grantId: string | null; consumerName: string },
  src: SourceIn,
): Promise<{ id: string } | { error: string }> {
  const kind = typeof src.kind === 'string' ? src.kind.toUpperCase() : ''
  if (!(SOURCE_TYPES as readonly string[]).includes(kind)) return { error: `source.kind must be one of ${SOURCE_TYPES.join(', ')}` }
  const sha = typeof src.sha256 === 'string' ? src.sha256.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(sha)) return { error: 'source.sha256 must be a 64-char hex sha256' }
  const storageUri = typeof src.storage_uri === 'string' && src.storage_uri.trim() ? src.storage_uri.trim() : `agent://${auth.consumerName}/${sha}`
  const modality = typeof src.modality === 'string' && (MODALITIES as readonly string[]).includes(src.modality) ? src.modality : 'text'

  const client = await db().connect()
  try {
    await client.query('BEGIN')
    // Reuse the row if this export was already deposited (UNIQUE (tenant, user, sha256)).
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM raw_vault_files WHERE tenant_id = $1 AND user_id = $2 AND sha256_checksum = $3`,
      [auth.tenantId, auth.userId, sha],
    )
    if (existing.rows[0]) {
      await client.query('COMMIT')
      return { id: existing.rows[0].id }
    }
    // A DATA_IN token already has a grant; the demo owner (no header) gets a dedicated DATA_IN grant.
    let grantId = auth.grantId
    if (!grantId) {
      const g = await client.query<{ id: string }>(
        `SELECT id FROM consent_grants
          WHERE tenant_id = $1 AND user_id = $2 AND direction = 'DATA_IN' AND counterparty = 'normalizer' AND status = 'ACTIVE'
          ORDER BY granted_at DESC LIMIT 1`,
        [auth.tenantId, auth.userId],
      )
      grantId = g.rows[0]?.id ?? null
      if (!grantId) {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO consent_grants (tenant_id, user_id, direction, counterparty, allowed_scopes, exclusive, status)
           VALUES ($1, $2, 'DATA_IN', 'normalizer', $3::text[], FALSE, 'ACTIVE') RETURNING id`,
          [auth.tenantId, auth.userId, ['work_profile', 'coding_preferences', 'shopping_preferences', 'personal_memory', 'health_finance_restricted']],
        )
        grantId = ins.rows[0]!.id
      }
    }
    const file = await client.query<{ id: string }>(
      `INSERT INTO raw_vault_files (tenant_id, user_id, consent_grant_id, source_type, modality, storage_uri, sha256_checksum, sync_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'AVAILABLE')
       ON CONFLICT (tenant_id, user_id, sha256_checksum) DO UPDATE SET sync_status = raw_vault_files.sync_status
       RETURNING id`,
      [auth.tenantId, auth.userId, grantId, kind, modality, storageUri, sha],
    )
    await client.query('COMMIT')
    return { id: file.rows[0]!.id }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

facts.post('/facts', requireDataIn, async (c) => {
  const auth = c.get('auth')
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', message: 'Body must be JSON' }, 400)
  }
  const body = parseBody(raw)
  if ('error' in body) return c.json({ error: 'invalid_request', message: body.error }, 400)
  if (body.facts.length > MAX_FACTS)
    return c.json({ error: 'invalid_request', message: `At most ${MAX_FACTS} facts per request` }, 400)

  // Resolve the default raw file: explicit body.raw_file_id, or the `source` convenience.
  let defaultRawFileId: string | null = body.raw_file_id ?? null
  let sourceFile: { id: string } | null = null
  if (!defaultRawFileId && body.source) {
    const r = await ensureRawFile(auth, body.source)
    if ('error' in r) return c.json({ error: 'invalid_source', message: r.error }, 400)
    sourceFile = r
    defaultRawFileId = r.id
  }

  // raw_file_id must exist for this owner. Cache lookups per request (not across requests).
  const knownFiles = new Map<string, boolean>()
  const fileExists = async (id: string) => {
    const hit = knownFiles.get(id)
    if (hit !== undefined) return hit
    const { rows } = await query(
      `SELECT 1 FROM raw_vault_files WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND sync_status <> 'SHREDDED'`,
      [id, auth.tenantId, auth.userId],
    )
    const ok = rows.length > 0
    knownFiles.set(id, ok)
    return ok
  }

  const provider = (body.source_provider?.trim() || auth.consumerName).slice(0, 100)
  const rejected: { index: number; reason: string }[] = []
  const scrubbedKinds: Record<string, number> = {}
  let quarantined = 0
  const accepted: {
    index: number
    fact: string
    category: Scope
    confidence: number
    provenance: string
    rawFileId: string
    modality: Modality
  }[] = []

  for (let i = 0; i < body.facts.length; i++) {
    const f = body.facts[i] ?? {}
    const text = typeof f.fact === 'string' ? f.fact.trim() : ''
    if (!text) {
      rejected.push({ index: i, reason: 'fact must be a non-empty string' })
      continue
    }
    if (text.length > MAX_FACT_LEN) {
      rejected.push({ index: i, reason: `fact longer than ${MAX_FACT_LEN} chars` })
      continue
    }
    if (!isScope(f.category)) {
      rejected.push({ index: i, reason: 'category must be one of the five scopes' })
      continue
    }
    const provenance = typeof f.provenance === 'string' ? f.provenance.trim() : ''
    if (!provenance) {
      rejected.push({ index: i, reason: 'provenance required (no provenance, no row)' })
      continue
    }
    const rawFileId = typeof f.raw_file_id === 'string' && f.raw_file_id ? f.raw_file_id : defaultRawFileId
    if (!rawFileId || !isUuid(rawFileId)) {
      rejected.push({ index: i, reason: 'raw_file_id required (uuid), or send `source` once for the whole batch' })
      continue
    }
    if (!(await fileExists(rawFileId))) {
      rejected.push({ index: i, reason: 'raw_file_id not found in this wallet' })
      continue
    }
    // Scrubber: a secret anywhere in the fact (or its provenance) means the fact is dropped, not stored redacted.
    if (containsSecret(text) || containsSecret(provenance)) {
      quarantined++
      for (const h of scrub(text).hits) scrubbedKinds[h.kind] = (scrubbedKinds[h.kind] ?? 0) + 1
      rejected.push({ index: i, reason: 'contains a secret; not stored' })
      continue
    }
    let confidence = typeof f.confidence === 'number' && Number.isFinite(f.confidence) ? f.confidence : 1
    confidence = Math.min(1, Math.max(0, Math.round(confidence * 100) / 100))
    const modality =
      typeof f.modality === 'string' && (MODALITIES as readonly string[]).includes(f.modality) ? (f.modality as Modality) : 'text'
    accepted.push({ index: i, fact: text, category: f.category, confidence, provenance, rawFileId, modality })
  }

  // Insert, deduping on (raw_file_id, provenance, fact) so re-posting is idempotent.
  let inserted = 0
  let duplicates = 0
  const categories = new Set<string>()
  if (accepted.length) {
    const client = await db().connect()
    try {
      await client.query('BEGIN')
      for (const a of accepted) {
        const r = await client.query(
          `INSERT INTO canonical_memories
             (tenant_id, user_id, raw_file_id, scope_category, fact_assertion, confidence_score, source_provider, source_provenance_ref, modality)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
            WHERE NOT EXISTS (
              SELECT 1 FROM canonical_memories
               WHERE tenant_id = $1 AND user_id = $2 AND raw_file_id = $3 AND source_provenance_ref = $8 AND fact_assertion = $5)`,
          [auth.tenantId, auth.userId, a.rawFileId, a.category, a.fact, a.confidence, provider, a.provenance, a.modality],
        )
        if (r.rowCount) {
          inserted++
          categories.add(a.category)
        } else duplicates++
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  await ledger({
    tenantId: auth.tenantId,
    userId: auth.userId,
    tokenId: auth.tokenId,
    consumerName: auth.consumerName,
    operation: 'FACTS_INGESTED',
    scopesRequested: [...categories],
    scopesServed: [...categories],
    recordsReturned: inserted,
    detail: {
      source_provider: provider,
      received: body.facts.length,
      inserted,
      duplicates,
      rejected: rejected.length,
      quarantined,
      scrubbed_kinds: scrubbedKinds,
      raw_file_id: defaultRawFileId,
    },
  })

  return c.json(
    {
      inserted,
      duplicates,
      rejected,
      quarantined,
      raw_file_id: defaultRawFileId,
      ...(sourceFile ? { source_file: sourceFile } : {}),
    },
    200,
  )
})

export default facts
