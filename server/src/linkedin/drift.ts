// Drift check: wallet vs live LinkedIn (CLAUDE.md "Live LinkedIn API + drift check").
// Live source = Member Data Portability API (EEA/CH members only, env LINKEDIN_DMA_TOKEN), or the mock snapshot.
// driftCheck() changes nothing and writes a LINKEDIN_DRIFT_CHECK ledger row; applyDrift() writes after the owner says yes.
import { db, query } from '../db.js'
import { ledger } from '../ledger.js'
import { OWNER } from '../auth.js'
import { ALLOWLIST, diffDistilled, distil, snapshotFromApi, type Distilled, type Domain, type Snapshot, type Education, type Position } from './parse.js'
import { isMock, mockLiveSnapshot } from './mock.js'
import { putObject, sha256 } from './storage.js'

const API = 'https://api.linkedin.com/rest/memberSnapshotData'
const API_VERSION = '202312' // the only version the DMA endpoint accepts
const PAGE = 50
const MAX_PAGES = 200

/** Fetch every allowlisted domain from the real DMA API. Pages until "No data found"; paging.total is unreliable. */
async function liveSnapshotFromApi(token: string): Promise<Snapshot> {
  const snap: Snapshot = {}
  for (const domain of ALLOWLIST) {
    const rows: Snapshot[Domain] = []
    for (let start = 0, page = 0; page < MAX_PAGES; start += PAGE, page++) {
      const url = `${API}?q=criteria&domain=${domain}&start=${start}&count=${PAGE}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Linkedin-Version': API_VERSION, 'X-Restli-Protocol-Version': '2.0.0' } })
      const text = await res.text()
      if (res.status === 404 || /No data found/i.test(text)) break
      if (!res.ok) throw new Error(`LinkedIn API ${domain}: HTTP ${res.status} ${text.slice(0, 200)}`)
      const batch = snapshotFromApi(domain, JSON.parse(text))
      if (!batch.length) break
      rows.push(...batch)
      if (batch.length < PAGE) break
    }
    snap[domain] = rows
  }
  return snap
}

async function liveSnapshot(): Promise<{ snapshot: Snapshot; source: 'linkedin_mock_api' | 'linkedin_dma_api' }> {
  const token = process.env.LINKEDIN_DMA_TOKEN
  if (token && !isMock()) return { snapshot: await liveSnapshotFromApi(token), source: 'linkedin_dma_api' }
  if (!isMock()) throw Object.assign(new Error('No live LinkedIn source: set LINKEDIN_DMA_TOKEN (EEA/CH members) or MOCK_LINKEDIN=1'), { code: 'NO_LIVE_SOURCE' })
  return { snapshot: await mockLiveSnapshot(), source: 'linkedin_mock_api' }
}

/** What the wallet currently holds from LinkedIn, in the same shape the parser produces. */
async function walletView(tenantId: string, userId: string): Promise<Distilled | null> {
  const { rows } = await query<{ identity_card: Record<string, string>; work_history: (Position | Education)[]; social_graph_summary: Distilled['social_graph_summary'] }>(
    `SELECT identity_card, work_history, social_graph_summary FROM canonical_profiles WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  )
  const p = rows[0]
  if (!p) return null
  const mem = await query<{ fact_assertion: string; source_provenance_ref: string }>(
    `SELECT fact_assertion, source_provenance_ref FROM canonical_memories
      WHERE tenant_id = $1 AND user_id = $2 AND is_quarantined = FALSE AND source_provenance_ref LIKE 'linkedin:Skills.csv#%'
      ORDER BY source_provenance_ref`,
    [tenantId, userId],
  )
  const skills = mem.rows.flatMap((r) => {
    const m = /lists (.+) as a skill on LinkedIn\.$/.exec(r.fact_assertion)
    return m ? [{ skill: m[1]!, fact: r.fact_assertion, category: 'work_profile' as const, provenance: r.source_provenance_ref }] : []
  })
  const wh = Array.isArray(p.work_history) ? p.work_history : []
  const sg = p.social_graph_summary ?? { connections_count: 0, top_companies: [], source: '' }
  return {
    identity_card: p.identity_card ?? {},
    work_history: wh,
    skills,
    social_graph_summary: { connections_count: Number(sg.connections_count ?? 0), top_companies: sg.top_companies ?? [], source: sg.source ?? '' },
    counts: {
      positions: wh.filter((w) => w.kind === 'position').length,
      education: wh.filter((w) => w.kind === 'education').length,
      skills: skills.length,
      connections: Number(sg.connections_count ?? 0),
    },
  }
}

export async function driftCheck(tenantId: string = OWNER.tenantId, userId: string = OWNER.userId) {
  const before = await walletView(tenantId, userId)
  if (!before) return { error: 'NO_LINKEDIN_DATA', message: 'The wallet holds no LinkedIn data yet. Run wallet_request_linkedin_export first.' }
  const { snapshot, source } = await liveSnapshot()
  const after = distil(snapshot, 'linkedin')
  const drift = diffDistilled(before, after)
  const changed = (Object.keys(drift) as Domain[]).filter((d) => !drift[d].unchanged)
  await ledger({
    tenantId,
    userId,
    consumerName: source,
    operation: 'LINKEDIN_DRIFT_CHECK',
    scopesRequested: ['work_profile'],
    scopesServed: ['work_profile'],
    recordsReturned: changed.length,
    detail: { domains_requested: ALLOWLIST, domains_changed: changed, read_only: true },
  })
  return {
    source,
    requested_domains: ALLOWLIST,
    checked_at: new Date().toISOString(),
    in_sync: changed.length === 0,
    domains_changed: changed,
    domains: drift,
    note: 'Read-only. Nothing was changed. Call wallet_linkedin_apply_drift (POST /v1/sources/linkedin/apply-drift) to apply.',
  }
}

/** Apply the live snapshot to the wallet: store it as a raw file, rewrite profile + skills. Owner said yes first. */
export async function applyDrift(tenantId: string = OWNER.tenantId, userId: string = OWNER.userId) {
  const before = await walletView(tenantId, userId)
  const { snapshot, source } = await liveSnapshot()
  const after = distil(snapshot, 'linkedin')
  const drift = before ? diffDistilled(before, after) : null

  const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
  const digest = sha256(bytes)
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const grant = (
      await client.query<{ id: string }>(
        `INSERT INTO consent_grants (tenant_id, user_id, direction, counterparty, allowed_scopes, status)
         VALUES ($1, $2, 'DATA_IN', 'linkedin', ARRAY['work_profile'], 'ACTIVE') RETURNING id`,
        [tenantId, userId],
      )
    ).rows[0]!
    const uri = await putObject(`linkedin/${userId}/api-${digest}.json`, bytes, 'application/json')
    const raw = (
      await client.query<{ id: string }>(
        `INSERT INTO raw_vault_files (tenant_id, user_id, consent_grant_id, source_type, modality, storage_uri, sha256_checksum, sync_status)
         VALUES ($1, $2, $3, 'LINKEDIN_EXPORT', 'text', $4, $5, 'AVAILABLE')
         ON CONFLICT (tenant_id, user_id, sha256_checksum) DO UPDATE SET sync_status = 'AVAILABLE' RETURNING id`,
        [tenantId, userId, grant.id, uri, digest],
      )
    ).rows[0]!
    const ext = { linkedin: { last_drift_apply_at: new Date().toISOString(), source, raw_file_id: raw.id } }
    await client.query(
      `INSERT INTO canonical_profiles (tenant_id, user_id, identity_card, work_history, social_graph_summary, source_extensions, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         identity_card = canonical_profiles.identity_card || EXCLUDED.identity_card,
         work_history = EXCLUDED.work_history,
         social_graph_summary = EXCLUDED.social_graph_summary,
         source_extensions = canonical_profiles.source_extensions || EXCLUDED.source_extensions,
         updated_at = NOW()`,
      [tenantId, userId, JSON.stringify(after.identity_card), JSON.stringify(after.work_history), JSON.stringify(after.social_graph_summary), JSON.stringify(ext)],
    )
    // Skills: the live list replaces the archive list (removed skills go, e.g. -Fastify; added ones come, e.g. +Rust).
    await client.query(`DELETE FROM canonical_memories WHERE tenant_id = $1 AND user_id = $2 AND source_provenance_ref LIKE 'linkedin:Skills.csv#%'`, [tenantId, userId])
    for (const s of after.skills)
      await client.query(
        `INSERT INTO canonical_memories (tenant_id, user_id, raw_file_id, scope_category, fact_assertion, confidence_score, source_provider, source_provenance_ref, modality)
         VALUES ($1, $2, $3, 'work_profile', $4, 1.00, $5, $6, 'text')`,
        [tenantId, userId, raw.id, s.fact, source === 'linkedin_dma_api' ? 'linkedin' : 'linkedin_mock', s.provenance],
      )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  await ledger({
    tenantId,
    userId,
    consumerName: source,
    operation: 'LINKEDIN_DRIFT_APPLIED',
    scopesServed: ['work_profile'],
    recordsReturned: after.skills.length,
    detail: { domains: ALLOWLIST, drift },
  })
  return { source, applied_at: new Date().toISOString(), domains: drift, summary: after.counts }
}
