// ONE parser for LinkedIn data, whichever way it arrives (CLAUDE.md "Live LinkedIn API + drift check"):
//   - the GDPR export zip (Profile.csv, Positions.csv, Education.csv, Skills.csv, Connections.csv, messages.csv)
//   - the Member Data Portability API (`elements[0].snapshotData`: records keyed exactly like the CSV headers)
// Both become `Record<string, string>[]` per domain, then `distil()` turns them into wallet shapes.
//
// Privacy rules baked in here, not left to callers:
//   Connections -> count + top companies only. Names, URLs and emails are other people's data and never leave this function.
//   messages.csv -> skipped entirely (it is a conversation with third parties).
//   Profile -> no birth date, address or zip code: not needed for an identity card.
import { unzipSync, strFromU8 } from 'fflate'

export type Row = Record<string, string>
export type Domain = 'PROFILE' | 'POSITIONS' | 'EDUCATION' | 'SKILLS' | 'CONNECTIONS'
export const ALLOWLIST: readonly Domain[] = ['PROFILE', 'POSITIONS', 'EDUCATION', 'SKILLS', 'CONNECTIONS']
/** Export file name per domain (used for provenance refs in both paths, so facts from zip and API line up). */
export const DOMAIN_FILE: Record<Domain, string> = {
  PROFILE: 'Profile.csv',
  POSITIONS: 'Positions.csv',
  EDUCATION: 'Education.csv',
  SKILLS: 'Skills.csv',
  CONNECTIONS: 'Connections.csv',
}

export type Snapshot = Partial<Record<Domain, Row[]>>

// ---------- CSV ----------

/** RFC 4180 parser: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.startsWith('﻿') ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      out.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field.length || row.length) {
    row.push(field)
    out.push(row)
  }
  return out
}

/**
 * CSV text -> rows keyed by header. LinkedIn prefixes some files (Connections.csv) with a "Notes:" preamble and a
 * blank line before the real header, so the header is the first non-empty line after any such preamble.
 */
export function csvRows(text: string): Row[] {
  const lines = parseCsv(text)
  let start = 0
  if (lines[0]?.[0]?.trim().toLowerCase().startsWith('notes:')) {
    start = lines.findIndex((l, i) => i > 0 && l.every((f) => f.trim() === '')) + 1
    while (start < lines.length && lines[start]!.every((f) => f.trim() === '')) start++
  }
  const header = (lines[start] ?? []).map((h) => h.trim())
  if (!header.length || header.every((h) => !h)) return []
  const rows: Row[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.every((f) => f.trim() === '')) continue
    const r: Row = {}
    header.forEach((h, i) => {
      if (h) r[h] = (line[i] ?? '').trim()
    })
    rows.push(r)
  }
  return rows
}

// ---------- zip -> Snapshot ----------

/** Throws if the bytes are not a zip or carry none of the allowlisted CSVs (that is the "corrupt archive" case). */
export function snapshotFromZip(bytes: Uint8Array): Snapshot {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (err) {
    throw new Error(`archive is not a readable zip: ${(err as Error).message}`)
  }
  const snap: Snapshot = {}
  for (const [path, data] of Object.entries(files)) {
    const base = path.split('/').pop() ?? path
    const domain = (Object.keys(DOMAIN_FILE) as Domain[]).find((d) => DOMAIN_FILE[d].toLowerCase() === base.toLowerCase())
    if (!domain) continue // messages.csv and everything else: skipped by design
    snap[domain] = csvRows(strFromU8(data))
  }
  if (!Object.keys(snap).length) throw new Error('archive contains none of Profile/Positions/Education/Skills/Connections')
  return snap
}

/** DMA API response (`elements[0].snapshotData`) or the mock's `{DOMAIN: rows[]}` file -> Snapshot. */
export function snapshotFromApi(domain: Domain, body: unknown): Row[] {
  if (Array.isArray(body)) return body.map(normaliseRow)
  const b = body as { elements?: { snapshotData?: unknown[] }[] }
  const data = b?.elements?.[0]?.snapshotData
  return Array.isArray(data) ? data.map(normaliseRow) : []
}

function normaliseRow(r: unknown): Row {
  const out: Row = {}
  if (r && typeof r === 'object') for (const [k, v] of Object.entries(r as Record<string, unknown>)) out[k.trim()] = v == null ? '' : String(v).trim()
  return out
}

// ---------- Snapshot -> wallet shapes ----------

export interface Position {
  kind: 'position'
  company: string
  title: string
  description?: string
  location?: string
  started_on?: string
  finished_on?: string | null
  source: string
}
export interface Education {
  kind: 'education'
  school: string
  degree?: string
  started_on?: string
  finished_on?: string
  activities?: string
  source: string
}
export interface SkillFact {
  fact: string
  skill: string
  category: 'work_profile'
  provenance: string
}
export interface Distilled {
  identity_card: Record<string, string>
  work_history: (Position | Education)[]
  skills: SkillFact[]
  social_graph_summary: { connections_count: number; top_companies: { company: string; count: number }[]; source: string }
  counts: { positions: number; education: number; skills: number; connections: number }
}

const clean = (s: string | undefined) => (s ?? '').trim()
const pick = (r: Row, ...keys: string[]) => {
  for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]!
  return ''
}

export function distil(snap: Snapshot, prefix = 'linkedin'): Distilled {
  const ref = (d: Domain, row: number) => `${prefix}:${DOMAIN_FILE[d]}#${row}`

  const p = snap.PROFILE?.[0] ?? {}
  const first = clean(pick(p, 'First Name', 'firstName'))
  const last = clean(pick(p, 'Last Name', 'lastName'))
  const identity_card: Record<string, string> = {}
  const fullName = [first, last].filter(Boolean).join(' ')
  if (fullName) identity_card.full_name = fullName
  if (first) identity_card.first_name = first
  if (last) identity_card.last_name = last
  const headline = clean(pick(p, 'Headline'))
  if (headline) identity_card.headline = headline
  const summary = clean(pick(p, 'Summary'))
  if (summary) identity_card.summary = summary
  const industry = clean(pick(p, 'Industry'))
  if (industry) identity_card.industry = industry
  const location = clean(pick(p, 'Geo Location', 'Location'))
  if (location) identity_card.location = location
  if (Object.keys(identity_card).length) identity_card.source = ref('PROFILE', 1)

  const work_history: (Position | Education)[] = []
  ;(snap.POSITIONS ?? []).forEach((r, i) => {
    const company = clean(pick(r, 'Company Name', 'Company'))
    const title = clean(pick(r, 'Title'))
    if (!company && !title) return
    const pos: Position = { kind: 'position', company, title, source: ref('POSITIONS', i + 1) }
    const description = clean(pick(r, 'Description'))
    if (description) pos.description = description
    const loc = clean(pick(r, 'Location'))
    if (loc) pos.location = loc
    const started = clean(pick(r, 'Started On'))
    if (started) pos.started_on = started
    pos.finished_on = clean(pick(r, 'Finished On')) || null
    work_history.push(pos)
  })
  ;(snap.EDUCATION ?? []).forEach((r, i) => {
    const school = clean(pick(r, 'School Name', 'School'))
    if (!school) return
    const ed: Education = { kind: 'education', school, source: ref('EDUCATION', i + 1) }
    const degree = clean(pick(r, 'Degree Name', 'Degree'))
    if (degree) ed.degree = degree
    const s = clean(pick(r, 'Start Date'))
    if (s) ed.started_on = s
    const e = clean(pick(r, 'End Date'))
    if (e) ed.finished_on = e
    const a = clean(pick(r, 'Activities'))
    if (a) ed.activities = a
    work_history.push(ed)
  })

  const skills: SkillFact[] = []
  ;(snap.SKILLS ?? []).forEach((r, i) => {
    const skill = clean(pick(r, 'Name', 'Skill'))
    if (!skill) return
    skills.push({
      skill,
      fact: `${fullName || 'The owner'} lists ${skill} as a skill on LinkedIn.`,
      category: 'work_profile',
      provenance: ref('SKILLS', i + 1),
    })
  })

  // Connections: aggregate only. Rows are read for Company and then dropped.
  const companies = new Map<string, number>()
  let connections = 0
  for (const r of snap.CONNECTIONS ?? []) {
    const anyValue = Object.values(r).some((v) => v !== '')
    if (!anyValue) continue
    connections++
    const company = clean(pick(r, 'Company'))
    if (company) companies.set(company, (companies.get(company) ?? 0) + 1)
  }
  const top_companies = [...companies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([company, count]) => ({ company, count }))

  return {
    identity_card,
    work_history,
    skills,
    social_graph_summary: { connections_count: connections, top_companies, source: `${prefix}:${DOMAIN_FILE.CONNECTIONS} (aggregate only)` },
    counts: {
      positions: work_history.filter((w) => w.kind === 'position').length,
      education: work_history.filter((w) => w.kind === 'education').length,
      skills: skills.length,
      connections,
    },
  }
}

// ---------- drift: wallet snapshot vs live snapshot, per domain ----------

export interface DomainDrift {
  details?: unknown[]
  added?: unknown[]
  removed?: unknown[]
  changed?: unknown[]
  count_before?: number
  count_after?: number
  unchanged?: boolean
}

/** Diff two distilled views. Connections compare as counts only. Changes nothing. */
export function diffDistilled(before: Distilled, after: Distilled): Record<Domain, DomainDrift> {
  const out = {} as Record<Domain, DomainDrift>

  // PROFILE: report the export's own field names (Headline, Summary, ...) so zip and API drift read the same.
  const profileFields: [string, string][] = [['full_name', 'Name'], ['headline', 'Headline'], ['summary', 'Summary'], ['industry', 'Industry'], ['location', 'Geo Location']]
  const profileDetails = profileFields
    .filter(([k]) => (before.identity_card[k] ?? '') !== (after.identity_card[k] ?? ''))
    .map(([k, field]) => ({ field, before: before.identity_card[k] ?? '', after: after.identity_card[k] ?? '' }))
  out.PROFILE = profileDetails.length ? { changed: profileDetails.map((d) => d.field), details: profileDetails } : { unchanged: true }

  const posKey = (p: Position) => `${p.company}|${p.started_on ?? ''}`
  const bPos = before.work_history.filter((w): w is Position => w.kind === 'position')
  const aPos = after.work_history.filter((w): w is Position => w.kind === 'position')
  const bMap = new Map(bPos.map((p) => [posKey(p), p]))
  const aMap = new Map(aPos.map((p) => [posKey(p), p]))
  const added: unknown[] = [],
    removed: unknown[] = [],
    changed: unknown[] = []
  for (const [k, a] of aMap) {
    const b = bMap.get(k)
    if (!b) added.push({ company: a.company, title: a.title, started_on: a.started_on ?? null })
    else if (b.title !== a.title || (b.finished_on ?? null) !== (a.finished_on ?? null))
      changed.push({ company: a.company, before: b.title, after: a.title, finished_on: a.finished_on ?? null })
  }
  for (const [k, b] of bMap) if (!aMap.has(k)) removed.push({ company: b.company, title: b.title })
  out.POSITIONS = added.length || removed.length || changed.length ? { added, removed, changed } : { unchanged: true }

  const edKey = (e: Education) => `${e.school}|${e.degree ?? ''}|${e.started_on ?? ''}|${e.finished_on ?? ''}`
  const bEd = new Set(before.work_history.filter((w): w is Education => w.kind === 'education').map(edKey))
  const aEd = new Set(after.work_history.filter((w): w is Education => w.kind === 'education').map(edKey))
  const edAdded = [...aEd].filter((k) => !bEd.has(k)).map((k) => k.split('|')[0])
  const edRemoved = [...bEd].filter((k) => !aEd.has(k)).map((k) => k.split('|')[0])
  out.EDUCATION = edAdded.length || edRemoved.length ? { added: edAdded, removed: edRemoved } : { unchanged: true }

  const bSk = new Set(before.skills.map((s) => s.skill))
  const aSk = new Set(after.skills.map((s) => s.skill))
  const skAdded = [...aSk].filter((s) => !bSk.has(s))
  const skRemoved = [...bSk].filter((s) => !aSk.has(s))
  out.SKILLS = skAdded.length || skRemoved.length ? { added: skAdded, removed: skRemoved } : { unchanged: true }

  const cb = before.social_graph_summary.connections_count
  const ca = after.social_graph_summary.connections_count
  out.CONNECTIONS = { count_before: cb, count_after: ca, ...(cb === ca ? { unchanged: true } : {}) }
  return out
}
