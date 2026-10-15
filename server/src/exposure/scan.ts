// Exposure Finder: where the OWNER's own personal data appears online (CLAUDE.md feature 13).
// Guardrails enforced here:
//   - scans use ONLY verified owner_identifiers rows; any other subject -> SUBJECT_NOT_OWNER (403 at the route)
//   - a page is an exposure only when a STRONG identifier (full name, email, username, phone) appears on it;
//     city/employer alone never match (the employer-only news page must not become an exposure)
//   - name-only hits with nothing corroborating are namesakes: confidence < 0.5, action none, owner_confirmed NULL
//   - robots-blocked pages are never fetched and are reported as "couldn't check"
//   - evidence_snippet is the minimum text that shows the match (the matched identifiers, not the page)
//   - rescans are idempotent (UNIQUE tenant,user,url) and never overwrite the owner's confirm/deny
//   - every scan writes an EXPOSURE_SCAN ledger row via the core ledger()
import { query } from '../db.js'
import { ledger } from '../ledger.js'
import { DEMO_OWNER_IDENTIFIERS, isMockWeb, webSource, type SiteType } from './mockweb.js'

export type IdentifierKind = 'full_name' | 'email' | 'phone' | 'username' | 'city' | 'employer'
export interface OwnerIdentifier {
  id: string
  kind: IdentifierKind
  value: string
  verified_via: string
}

/** Identifiers that on their own establish "this page is about the owner". */
const STRONG: IdentifierKind[] = ['email', 'username', 'phone', 'full_name']
/** Identifiers that only corroborate a strong match. */
const WEAK: IdentifierKind[] = ['city', 'employer']

export type Risk = 'low' | 'medium' | 'high'
export type Action = 'access_request' | 'erasure_request' | 'opt_out_form' | 'search_delisting' | 'account_delete' | 'monitor' | 'none'

export interface ExposureRow {
  id: string
  url: string
  site: string
  site_type: SiteType
  data_found: string[]
  match_confidence: string | number
  owner_confirmed: boolean | null
  risk: Risk
  recommended_action: Action
  controller_contact: string | null
  evidence_snippet: string
  found_by: string
  found_at: string
}

export interface ScanResult {
  scan_id: string
  queries: string[]
  exposures: ExposureRow[]
  skipped: { url: string; reason: string }[]
  seeded_identifiers?: boolean
}

// ---------------------------------------------------------------------------------------------------------------
// owner_identifiers
// ---------------------------------------------------------------------------------------------------------------
export async function listIdentifiers(tenantId: string, userId: string): Promise<OwnerIdentifier[]> {
  const { rows } = await query<OwnerIdentifier>(
    `SELECT id, kind, value, verified_via FROM owner_identifiers WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at`,
    [tenantId, userId],
  )
  return rows
}

export async function addIdentifier(tenantId: string, userId: string, kind: string, value: string, verifiedVia = 'manual_attest'): Promise<OwnerIdentifier> {
  const { rows } = await query<OwnerIdentifier>(
    `INSERT INTO owner_identifiers (tenant_id, user_id, kind, value, verified_via) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id, kind, value) DO UPDATE SET verified_via = EXCLUDED.verified_via
     RETURNING id, kind, value, verified_via`,
    [tenantId, userId, kind, value.trim(), verifiedVia],
  )
  return rows[0]!
}

export async function removeIdentifier(tenantId: string, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM owner_identifiers WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id])
  return (rowCount ?? 0) > 0
}

/** Mock mode only: seed the synthetic owner's identifiers when none exist, so the demo runs hands-free. */
async function ensureIdentifiers(tenantId: string, userId: string): Promise<{ ids: OwnerIdentifier[]; seeded: boolean }> {
  let ids = await listIdentifiers(tenantId, userId)
  if (ids.length || !isMockWeb()) return { ids, seeded: false }
  for (const d of DEMO_OWNER_IDENTIFIERS) await addIdentifier(tenantId, userId, d.kind, d.value, 'manual_attest')
  ids = await listIdentifiers(tenantId, userId)
  return { ids, seeded: true }
}

/** Is `subject` one of the owner's verified identifiers (case-insensitive)? Anything else is refused. */
export function subjectIsOwner(subject: string, ids: OwnerIdentifier[]): boolean {
  const s = subject.trim().toLowerCase()
  return ids.some((i) => i.value.trim().toLowerCase() === s)
}

// ---------------------------------------------------------------------------------------------------------------
// Queries: built ONLY from verified identifiers. Never from page content, never from names a page mentions.
// ---------------------------------------------------------------------------------------------------------------
export function buildQueries(ids: OwnerIdentifier[]): string[] {
  const by = (k: IdentifierKind) => ids.filter((i) => i.kind === k).map((i) => i.value)
  const q: string[] = []
  for (const name of by('full_name')) {
    q.push(`"${name}"`)
    for (const city of by('city')) q.push(`"${name}" "${city}"`)
    for (const emp of by('employer')) q.push(`"${name}" "${emp}"`)
  }
  for (const e of by('email')) q.push(`"${e}"`)
  for (const u of by('username')) q.push(`"${u}"`)
  for (const p of by('phone')) q.push(`"${p}"`)
  return [...new Set(q)]
}

// ---------------------------------------------------------------------------------------------------------------
// Matching a fetched page against the identifiers
// ---------------------------------------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Match {
  matched: { kind: IdentifierKind; value: string }[]
  data_found: string[]
  confidence: number
  evidence: string
}

/** What personal-data categories the page shows (about the matched person). */
function detectDataFound(text: string, matched: Match['matched']): string[] {
  const found = new Set<string>(matched.map((m) => m.kind))
  const t = text
  if (/\b0\d{4}\s?\d{6}\b|\+44\s?\d{4}\s?\d{6}|\bphone\b/i.test(t)) found.add('phone')
  if (/\brelatives?\b/i.test(t)) found.add('relatives')
  if (/\bage\s?\d{2}\s?-\s?\d{2}\b|\b\d{2}-\d{2}\b(?=.*\b(segment|age)\b)/i.test(t)) found.add('age_range')
  if (/\binterests?:/i.test(t)) found.add('interests')
  if (/\bpasswords?\b/i.test(t)) found.add('password_hash')
  if (/\bpostcodes?\b|\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/.test(t)) found.add('postcode')
  if (/\b(engineer|manager|director|developer|consultant|analyst|lead|head of)\b/i.test(t)) found.add('job_title')
  if (!found.has('email') && /[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) found.add('email_other')
  return [...found]
}

/** `text` is the page body; `site` and `url` count too (an employer's own domain names the employer). */
export function matchPage(text: string, ids: OwnerIdentifier[], site = '', url = ''): Match | null {
  const hay = `${site}\n${url}\n${text}`
  const lower = hay.toLowerCase()
  const matched: Match['matched'] = []
  for (const i of ids) {
    const v = i.value.trim()
    if (!v) continue
    const re = i.kind === 'full_name' || i.kind === 'city' || i.kind === 'employer' ? new RegExp(`\\b${esc(v)}\\b`, 'i') : new RegExp(esc(v), 'i')
    if (re.test(lower)) matched.push({ kind: i.kind, value: v })
  }
  const strong = matched.filter((m) => STRONG.includes(m.kind))
  if (!strong.length) return null // weak-only (city, employer) is never a match
  const weak = matched.filter((m) => WEAK.includes(m.kind))

  // Confidence: unique identifiers are near-certain; a bare full name is a namesake until corroborated.
  let confidence = 0
  if (strong.some((m) => m.kind === 'email')) confidence = 0.95
  else if (strong.some((m) => m.kind === 'phone')) confidence = 0.9
  else if (strong.some((m) => m.kind === 'username')) confidence = 0.85
  else confidence = 0.4 // full_name only
  confidence = Math.min(0.98, confidence + 0.25 * weak.length + (strong.length > 1 ? 0.05 : 0))

  // Evidence: the matched identifiers as they appear, nothing else from the page.
  const evidence = matched
    .map((m) => {
      const idx = lower.indexOf(m.value.toLowerCase())
      return idx >= 0 ? hay.slice(idx, idx + m.value.length) : m.value
    })
    .join(' … ')
  return { matched, data_found: detectDataFound(text, matched), confidence: Number(confidence.toFixed(2)), evidence }
}

/** Risk and recommended workflow per source type. Namesakes always get `none` until the owner confirms. */
export function assess(siteType: SiteType, dataFound: string[], confidence: number, ownerConfirmed: boolean | null): { risk: Risk; action: Action } {
  const sensitive = dataFound.some((d) => ['phone', 'relatives', 'postcode', 'password_hash', 'address'].includes(d))
  let risk: Risk
  let action: Action
  switch (siteType) {
    case 'people_search':
      risk = 'high'
      action = 'erasure_request'
      break
    case 'data_broker':
      risk = 'high'
      action = 'access_request' // access first: what comes back can be deposited into the wallet, then erase
      break
    case 'breach_notice':
      risk = 'high'
      action = 'monitor' // the notice is not the leak; rotate the password and watch
      break
    case 'forum':
      risk = sensitive || dataFound.includes('email') ? 'medium' : 'low'
      action = dataFound.includes('email') || sensitive ? 'erasure_request' : 'none'
      break
    case 'social_profile':
      risk = 'medium'
      action = 'account_delete'
      break
    case 'search_engine':
      risk = 'medium'
      action = 'search_delisting'
      break
    case 'news':
      risk = 'low'
      action = 'none'
      break
    case 'company_site':
      risk = sensitive ? 'medium' : 'low'
      action = sensitive ? 'erasure_request' : 'none'
      break
    default:
      risk = sensitive ? 'medium' : 'low'
      action = sensitive ? 'erasure_request' : 'monitor'
  }
  if (ownerConfirmed === false) return { risk: 'low', action: 'none' }
  if (ownerConfirmed !== true && confidence < 0.5) return { risk, action: 'none' } // probably not you: never acted on until confirmed
  return { risk, action }
}

// ---------------------------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------------------------
export async function scan(tenantId: string, userId: string): Promise<ScanResult> {
  const { ids, seeded } = await ensureIdentifiers(tenantId, userId)
  if (!ids.length) throw Object.assign(new Error('No verified owner identifiers; add one with POST /v1/owner-identifiers'), { code: 'NO_OWNER_IDENTIFIERS' })
  const web = webSource()
  const queries = buildQueries(ids)

  // 1. search: collect candidate URLs (never page content)
  const candidates = new Map<string, { site: string; site_type: SiteType }>()
  for (const q of queries) for (const hit of await web.search(q)) if (!candidates.has(hit.url)) candidates.set(hit.url, { site: hit.site, site_type: hit.site_type })

  // 2. fetch what robots.txt allows, match, upsert
  const exposures: ExposureRow[] = []
  const skipped: { url: string; reason: string }[] = []
  for (const [url, meta] of candidates) {
    const page = await web.fetch(url)
    if (!page.allowed) {
      skipped.push({ url, reason: page.reason })
      continue
    }
    const m = matchPage(page.text, ids, page.site, url)
    if (!m) continue
    const { risk, action } = assess(page.site_type, m.data_found, m.confidence, null)
    const { rows } = await query<ExposureRow>(
      `INSERT INTO exposures (tenant_id, user_id, url, site, site_type, data_found, match_confidence, owner_confirmed, risk,
                              recommended_action, controller_contact, evidence_snippet, found_by)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, NULL, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id, user_id, url) DO UPDATE SET
         site = EXCLUDED.site, site_type = EXCLUDED.site_type, data_found = EXCLUDED.data_found,
         match_confidence = EXCLUDED.match_confidence,
         risk = CASE WHEN exposures.owner_confirmed = FALSE THEN 'low' ELSE EXCLUDED.risk END,
         recommended_action = CASE WHEN exposures.owner_confirmed = FALSE THEN 'none'
                                   WHEN exposures.owner_confirmed = TRUE AND EXCLUDED.recommended_action = 'none' AND EXCLUDED.match_confidence < 0.5 THEN exposures.recommended_action
                                   ELSE EXCLUDED.recommended_action END,
         controller_contact = EXCLUDED.controller_contact, evidence_snippet = EXCLUDED.evidence_snippet,
         found_by = EXCLUDED.found_by, found_at = NOW()
       RETURNING id, url, site, site_type, data_found, match_confidence, owner_confirmed, risk, recommended_action,
                 controller_contact, evidence_snippet, found_by, found_at`,
      [tenantId, userId, url, page.site || meta.site, page.site_type || meta.site_type, m.data_found, m.confidence, risk, action,
       page.privacy_contact ?? page.opt_out_form ?? null, m.evidence, web.name],
    )
    exposures.push(normalise(rows[0]!))
  }

  const scanId = crypto.randomUUID()
  await ledger({
    tenantId,
    userId,
    consumerName: 'owner',
    operation: 'EXPOSURE_SCAN',
    recordsReturned: exposures.length,
    detail: { scan_id: scanId, source: web.name, queries, candidates: candidates.size, skipped },
  })
  return { scan_id: scanId, queries, exposures, skipped, ...(seeded ? { seeded_identifiers: true } : {}) }
}

export function normalise(r: ExposureRow): ExposureRow {
  return { ...r, match_confidence: Number(r.match_confidence) }
}

export async function listExposures(tenantId: string, userId: string): Promise<ExposureRow[]> {
  const { rows } = await query<ExposureRow>(
    `SELECT id, url, site, site_type, data_found, match_confidence, owner_confirmed, risk, recommended_action,
            controller_contact, evidence_snippet, found_by, found_at
       FROM exposures WHERE tenant_id = $1 AND user_id = $2
      ORDER BY CASE risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, match_confidence DESC, found_at`,
    [tenantId, userId],
  )
  return rows.map(normalise)
}

export async function getExposure(tenantId: string, userId: string, id: string): Promise<ExposureRow | null> {
  const { rows } = await query<ExposureRow>(
    `SELECT id, url, site, site_type, data_found, match_confidence, owner_confirmed, risk, recommended_action,
            controller_contact, evidence_snippet, found_by, found_at
       FROM exposures WHERE tenant_id = $1 AND user_id = $2 AND id = $3`,
    [tenantId, userId, id],
  )
  return rows[0] ? normalise(rows[0]) : null
}

/** The owner says "that's me" / "not me". Re-derives risk + action; a denied page is never acted on. */
export async function confirmExposure(tenantId: string, userId: string, id: string, isMe: boolean): Promise<ExposureRow | null> {
  const e = await getExposure(tenantId, userId, id)
  if (!e) return null
  const { risk, action } = assess(e.site_type, e.data_found, Number(e.match_confidence), isMe)
  const { rows } = await query<ExposureRow>(
    `UPDATE exposures SET owner_confirmed = $4, risk = $5, recommended_action = $6
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3
      RETURNING id, url, site, site_type, data_found, match_confidence, owner_confirmed, risk, recommended_action,
                controller_contact, evidence_snippet, found_by, found_at`,
    [tenantId, userId, id, isMe, risk, action],
  )
  await ledger({
    tenantId,
    userId,
    consumerName: 'owner',
    operation: isMe ? 'EXPOSURE_CONFIRMED' : 'EXPOSURE_DENIED',
    recordsReturned: 1,
    detail: { exposure_id: id, url: e.url },
  })
  return rows[0] ? normalise(rows[0]) : null
}
