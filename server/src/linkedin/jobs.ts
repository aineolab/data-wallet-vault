// LinkedIn GDPR-export jobs: the state machine, the cron tick and the ingest step (CLAUDE.md "LinkedIn GDPR export flow").
//
//   REQUESTED -> AWAITING_ARCHIVE -> ARCHIVE_READY -> INGESTING -> AVAILABLE
//        └───────────┴───────────────────┴──────────────┴─> CANCELLED (grant revoked) | EXPIRED (72 h passed) | FAILED (3 parse attempts)
//
// Every transition inserts a source_job_events row (append-only trigger). Real flow: the human clicks on LinkedIn
// (-> confirmRequested), their own agent sees the "ready" email (-> archiveReady), they deposit the zip (-> deposit).
// Mock flow (MOCK_LINKEDIN=1): tick() does all of that by itself after `mock_delay_s`.
import type pg from 'pg'
import { db, query } from '../db.js'
import { ledger } from '../ledger.js'
import { OWNER } from '../auth.js'
import { distil, snapshotFromZip, type Distilled } from './parse.js'
import { decodeKnobs, encodeKnobs, isMock, mockArchive, mockKnobs } from './mock.js'
import { putObject, sha256 } from './storage.js'

export type JobState = 'REQUESTED' | 'AWAITING_ARCHIVE' | 'ARCHIVE_READY' | 'INGESTING' | 'AVAILABLE' | 'CANCELLED' | 'EXPIRED' | 'FAILED'
export const TERMINAL: readonly JobState[] = ['AVAILABLE', 'CANCELLED', 'EXPIRED', 'FAILED']
export type Provider = 'linkedin' | 'linkedin_mock'
export type ArchiveKind = 'fast' | 'full'

const MAX_ATTEMPTS = 3
const ARCHIVE_WINDOW_MS = 72 * 3600 * 1000 // LinkedIn keeps the download ~72 h
const READY_HINT_MS: Record<ArchiveKind, number> = { fast: 10 * 60 * 1000, full: 24 * 3600 * 1000 }
const RETRY_DELAY_MS = 60 * 1000 // real flow; the mock retries on the next tick
const DEEP_LINK = 'https://www.linkedin.com/mypreferences/d/download-my-data'

export interface JobRow {
  id: string
  tenant_id: string
  user_id: string
  consent_grant_id: string
  provider: Provider
  archive_kind: ArchiveKind
  state: JobState
  external_ref: string | null
  ready_hint_at: string | null
  archive_expires_at: string | null
  raw_file_id: string | null
  attempts: number
  last_error: string | null
  next_check_at: string
  created_at: string
  updated_at: string
}
export interface JobEvent {
  from_state: string | null
  to_state: string
  note: string | null
  created_at: string
}
export interface JobSummary {
  roles: number
  education: number
  skills: number
  connections_count: number
  top_companies: { company: string; count: number }[]
  connections_stored_by_name: false
  messages_skipped: true
  raw_file_id: string
  deduplicated: boolean
}

type Q = Pick<pg.PoolClient, 'query'>

const owner = (tenantId?: string, userId?: string) => ({ tenantId: tenantId ?? (OWNER.tenantId as string), userId: userId ?? (OWNER.userId as string) })

// ---------- transitions ----------

async function transition(q: Q, job: JobRow, to: JobState, note: string | null, patch: Record<string, unknown> = {}): Promise<JobRow> {
  const cols = Object.keys(patch)
  const sets = ['state = $2', 'updated_at = NOW()', ...cols.map((c, i) => `${c} = $${i + 4}`)]
  const { rows } = await q.query<JobRow>(
    `UPDATE source_jobs SET ${sets.join(', ')} WHERE id = $1 AND state = $3 RETURNING *`,
    [job.id, to, job.state, ...cols.map((c) => patch[c])],
  )
  const next = rows[0]
  if (!next) throw new Error(`job ${job.id}: lost race, state is no longer ${job.state}`)
  await q.query(`INSERT INTO source_job_events (job_id, from_state, to_state, note) VALUES ($1, $2, $3, $4)`, [job.id, job.state, to, note])
  return next
}

async function touch(q: Q, job: JobRow, patch: Record<string, unknown>): Promise<JobRow> {
  const cols = Object.keys(patch)
  const sets = ['updated_at = NOW()', ...cols.map((c, i) => `${c} = $${i + 2}`)]
  const { rows } = await q.query<JobRow>(`UPDATE source_jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [job.id, ...cols.map((c) => patch[c])])
  return rows[0] ?? job
}

// ---------- public API (used by /v1 routes and by the MCP owner tools) ----------

export interface RequestInput {
  archive_kind?: string
  mock_delay_s?: unknown
  mock_outcome?: unknown
  tenantId?: string
  userId?: string
}

/** wallet_request_linkedin_export: DATA_IN grant + REQUESTED job + the deep link and two-line instructions. */
export async function requestExport(input: RequestInput) {
  const { tenantId, userId } = owner(input.tenantId, input.userId)
  const archive_kind: ArchiveKind = input.archive_kind === 'full' ? 'full' : 'fast'
  const mock = isMock()
  const provider: Provider = mock ? 'linkedin_mock' : 'linkedin'
  const knobs = mock ? mockKnobs(input as Record<string, unknown>) : null

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
    // Mock: the human "clicks" one second from now (so the very first tick still shows REQUESTED), and the archive
    // is ready mock_delay_s after that. Real: we wait for confirmRequested(); the hint is LinkedIn's usual timing.
    const { rows } = await client.query<JobRow>(
      `INSERT INTO source_jobs (tenant_id, user_id, consent_grant_id, provider, archive_kind, state, external_ref, ready_hint_at, next_check_at)
       VALUES ($1, $2, $3, $4, $5, 'REQUESTED', $6, NOW() + ($7::int * INTERVAL '1 millisecond'), NOW() + INTERVAL '1 second')
       RETURNING *`,
      [tenantId, userId, grant.id, provider, archive_kind, knobs ? encodeKnobs(knobs) : null, knobs ? 1000 + knobs.mock_delay_s * 1000 : READY_HINT_MS[archive_kind]],
    )
    const job = rows[0]!
    await client.query(`INSERT INTO source_job_events (job_id, from_state, to_state, note) VALUES ($1, NULL, 'REQUESTED', $2)`, [
      job.id,
      mock ? `mock provider, delay ${knobs!.mock_delay_s}s, outcome ${knobs!.mock_outcome}` : `${archive_kind} archive requested; waiting for the owner to click on LinkedIn`,
    ])
    await client.query('COMMIT')
    return {
      job_id: job.id,
      grant_id: grant.id,
      state: job.state as JobState,
      provider,
      archive_kind,
      deep_link: DEEP_LINK,
      instructions: [
        `1. Open ${DEEP_LINK} (LinkedIn → Settings & Privacy → Get a copy of your data), choose "${archive_kind === 'fast' ? 'the fast archive (profile, connections, messages…)' : 'the full archive'}" and click Request archive. LinkedIn will ask for your password; the wallet never touches that page.`,
        `2. LinkedIn emails you when it is ready (${archive_kind === 'fast' ? 'about 10 minutes' : 'about 24 hours'}; the download link lasts ~72 h). Then download the zip and deposit it here, or let your agent watch your inbox and call wallet_archive_ready.`,
      ],
      ...(mock ? { mock: knobs } : {}),
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function loadJob(q: Q, id: string, forUpdate = false): Promise<JobRow | null> {
  const { rows } = await q.query<JobRow>(`SELECT * FROM source_jobs WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id])
  return rows[0] ?? null
}

/** The owner confirms they clicked "Request archive": REQUESTED -> AWAITING_ARCHIVE. */
export async function confirmRequested(jobId: string) {
  const job = await loadJob(db(), jobId)
  if (!job) return null
  if (job.state !== 'REQUESTED') return job
  return transition(db(), job, 'AWAITING_ARCHIVE', 'owner confirmed the request on LinkedIn', {
    ready_hint_at: new Date(Date.now() + READY_HINT_MS[job.archive_kind]),
    next_check_at: new Date(Date.now() + READY_HINT_MS[job.archive_kind]),
  })
}

/** wallet_archive_ready: the owner's agent saw LinkedIn's "your data is ready" email. -> ARCHIVE_READY, 72 h window. */
export async function archiveReady(jobId: string) {
  const job = await loadJob(db(), jobId)
  if (!job) return null
  if (job.state !== 'REQUESTED' && job.state !== 'AWAITING_ARCHIVE') return job
  return transition(db(), job, 'ARCHIVE_READY', 'LinkedIn reported the archive is ready (signal from the owner agent)', {
    archive_expires_at: new Date(Date.now() + ARCHIVE_WINDOW_MS),
    next_check_at: new Date(Date.now() + ARCHIVE_WINDOW_MS),
  })
}

/** The owner deposits the downloaded zip (POST /v1/ingest with job_id, or wallet_deposit). Runs ingest inline. */
export async function deposit(jobId: string, bytes: Uint8Array, filename: string) {
  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const job = await loadJob(client, jobId, true)
    if (!job) {
      await client.query('ROLLBACK')
      return null
    }
    if (TERMINAL.includes(job.state)) {
      await client.query('ROLLBACK')
      return job
    }
    const ingesting = await transition(client, job, 'INGESTING', `archive deposited by the owner (${filename}, ${bytes.byteLength} bytes)`, {
      attempts: job.attempts + 1,
    })
    const result = await runIngest(client, ingesting, bytes, filename)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** DELETE /v1/grants/:id — revoke a DATA_IN grant. Its jobs go CANCELLED on the next tick. */
export async function revokeGrant(grantId: string, tenantId: string = OWNER.tenantId, userId: string = OWNER.userId) {
  const { rows } = await query<{ id: string; status: string; revoked_at: string; counterparty: string }>(
    `UPDATE consent_grants SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND direction = 'DATA_IN'
      RETURNING id, status, revoked_at, counterparty`,
    [grantId, tenantId, userId],
  )
  const g = rows[0]
  if (!g) return null
  await ledger({ tenantId, userId, consumerName: g.counterparty, operation: 'CONSENT_REVOKED', detail: { grant_id: g.id, direction: 'DATA_IN' } })
  // Cancel immediately as well, so the owner's next status call already says so (tick would do the same).
  await cancelRevoked(db(), tenantId, userId)
  return g
}

export async function listJobs(tenantId: string = OWNER.tenantId, userId: string = OWNER.userId) {
  const { rows } = await query<JobRow & { summary_note: string | null }>(
    `SELECT j.*, (SELECT e.note FROM source_job_events e WHERE e.job_id = j.id AND e.to_state = 'AVAILABLE' ORDER BY e.id DESC LIMIT 1) AS summary_note
       FROM source_jobs j WHERE j.tenant_id = $1 AND j.user_id = $2 ORDER BY j.created_at DESC LIMIT 100`,
    [tenantId, userId],
  )
  return rows.map((j) => ({
    id: j.id,
    provider: j.provider,
    archive_kind: j.archive_kind,
    state: j.state,
    created_at: j.created_at,
    updated_at: j.updated_at,
    ...(j.summary_note ? { summary: parseSummary(j.summary_note) } : {}),
  }))
}

export async function getJob(id: string, tenantId: string = OWNER.tenantId, userId: string = OWNER.userId) {
  const { rows } = await query<JobRow>(`SELECT * FROM source_jobs WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [id, tenantId, userId])
  const j = rows[0]
  if (!j) return null
  const events = (
    await query<JobEvent>(`SELECT from_state, to_state, note, created_at FROM source_job_events WHERE job_id = $1 ORDER BY id ASC`, [id])
  ).rows
  const available = [...events].reverse().find((e) => e.to_state === 'AVAILABLE')
  return {
    id: j.id,
    provider: j.provider,
    archive_kind: j.archive_kind,
    state: j.state,
    grant_id: j.consent_grant_id,
    raw_file_id: j.raw_file_id,
    attempts: j.attempts,
    last_error: j.last_error,
    ready_hint_at: j.ready_hint_at,
    archive_expires_at: j.archive_expires_at,
    next_check_at: j.next_check_at,
    created_at: j.created_at,
    updated_at: j.updated_at,
    summary: available ? parseSummary(available.note) : null,
    events: events.map((e) => ({ ...e, note: e.to_state === 'AVAILABLE' ? 'ingest complete' : e.note })),
  }
}

function parseSummary(note: string | null): JobSummary | string | null {
  if (!note) return null
  try {
    return JSON.parse(note) as JobSummary
  } catch {
    return note
  }
}

// ---------- tick ----------

export interface TickResult {
  now: string
  checked: number
  transitions: { job_id: string; from: JobState; to: JobState }[]
}

/** POST /v1/jobs/tick. Safe to call concurrently (per-job FOR UPDATE SKIP LOCKED). */
export async function tick(now = new Date()): Promise<TickResult> {
  const result: TickResult = { now: now.toISOString(), checked: 0, transitions: [] }
  const client = await db().connect()
  try {
    // 1. Consent revoked -> CANCELLED, whatever the state or schedule.
    for (const t of await cancelRevoked(client)) result.transitions.push(t)

    // 2. Due jobs.
    const { rows: due } = await client.query<{ id: string }>(
      `SELECT id FROM source_jobs WHERE state = ANY($1::text[]) AND next_check_at <= $2 ORDER BY next_check_at ASC LIMIT 50`,
      [['REQUESTED', 'AWAITING_ARCHIVE', 'ARCHIVE_READY', 'INGESTING'], now],
    )
    for (const { id } of due) {
      result.checked++
      await client.query('BEGIN')
      try {
        const { rows } = await client.query<JobRow>(`SELECT * FROM source_jobs WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id])
        let job = rows[0]
        if (!job || TERMINAL.includes(job.state)) {
          await client.query('COMMIT')
          continue
        }
        // Up to three hops per tick (mock auto-advances AWAITING_ARCHIVE -> ARCHIVE_READY -> INGESTING -> AVAILABLE).
        for (let hop = 0; hop < 4 && job && !TERMINAL.includes(job.state) && new Date(job.next_check_at) <= now; hop++) {
          const from = job.state
          job = await step(client, job, now)
          if (job.state !== from) result.transitions.push({ job_id: id, from, to: job.state })
          else break
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`tick: job ${id} failed`, (err as Error).message)
      }
    }
  } finally {
    client.release()
  }
  return result
}

async function cancelRevoked(q: Q, tenantId?: string, userId?: string) {
  const { rows } = await q.query<JobRow>(
    `SELECT j.* FROM source_jobs j JOIN consent_grants g ON g.id = j.consent_grant_id
      WHERE j.state <> ALL($1::text[]) AND g.status <> 'ACTIVE'
        AND ($2::uuid IS NULL OR j.tenant_id = $2) AND ($3::uuid IS NULL OR j.user_id = $3)`,
    [TERMINAL, tenantId ?? null, userId ?? null],
  )
  const out: TickResult['transitions'] = []
  for (const job of rows) {
    await transition(q, job, 'CANCELLED', 'consent grant revoked; archive will not be fetched')
    out.push({ job_id: job.id, from: job.state, to: 'CANCELLED' })
  }
  return out
}

/** One state hop for one due job. Returns the (possibly unchanged) job. */
async function step(q: Q, job: JobRow, now: Date): Promise<JobRow> {
  const mock = job.provider === 'linkedin_mock'
  const knobs = mock ? decodeKnobs(job.external_ref) : null

  // Download window closed -> EXPIRED (any waiting state).
  if (job.archive_expires_at && new Date(job.archive_expires_at) <= now && (job.state === 'ARCHIVE_READY' || job.state === 'AWAITING_ARCHIVE'))
    return transition(q, job, 'EXPIRED', 'the 72 h download window closed before the archive was deposited')

  switch (job.state) {
    case 'REQUESTED': {
      if (!mock) return touch(q, job, { next_check_at: new Date(now.getTime() + 5 * 60 * 1000) }) // waiting for the human
      return transition(q, job, 'AWAITING_ARCHIVE', 'mock: owner clicked "Request archive"', { next_check_at: job.ready_hint_at })
    }
    case 'AWAITING_ARCHIVE': {
      if (!mock) return touch(q, job, { next_check_at: new Date(now.getTime() + 5 * 60 * 1000) }) // waiting for the ready email
      if (job.ready_hint_at && new Date(job.ready_hint_at) > now) return touch(q, job, { next_check_at: job.ready_hint_at })
      if (knobs!.mock_outcome === 'expired') {
        // LinkedIn's email arrived, but by the time anyone looked the link was dead.
        const ready = await transition(q, job, 'ARCHIVE_READY', 'mock: archive ready email seen; download window already closed', {
          archive_expires_at: new Date(now.getTime() - 1000),
          next_check_at: now,
        })
        return transition(q, ready, 'EXPIRED', 'the 72 h download window closed before the archive was deposited')
      }
      return transition(q, job, 'ARCHIVE_READY', 'mock: "your data is ready" email seen by the owner agent', {
        archive_expires_at: new Date(now.getTime() + ARCHIVE_WINDOW_MS),
        next_check_at: now,
      })
    }
    case 'ARCHIVE_READY': {
      if (!mock) return touch(q, job, { next_check_at: new Date(Math.min(now.getTime() + 5 * 60 * 1000, new Date(job.archive_expires_at ?? now).getTime())) })
      const { filename, bytes } = await mockArchive(knobs!.mock_outcome)
      const ingesting = await transition(q, job, 'INGESTING', `mock: archive downloaded (${filename}, ${bytes.byteLength} bytes), attempt ${job.attempts + 1}`, {
        attempts: job.attempts + 1,
        next_check_at: now,
      })
      return runIngest(q, ingesting, bytes, filename)
    }
    case 'INGESTING': {
      // A crash mid-ingest left the job here. Count it as a failed attempt and go back to ARCHIVE_READY (or FAIL).
      return failAttempt(q, job, 'ingest interrupted before completion', now)
    }
    default:
      return job
  }
}

async function failAttempt(q: Q, job: JobRow, error: string, now: Date): Promise<JobRow> {
  const mock = job.provider === 'linkedin_mock'
  if (job.attempts >= MAX_ATTEMPTS)
    return transition(q, job, 'FAILED', `giving up after ${job.attempts} attempts: ${error}`, { last_error: error })
  return transition(q, job, 'ARCHIVE_READY', `attempt ${job.attempts} failed: ${error}; will retry`, {
    last_error: error,
    next_check_at: new Date(now.getTime() + (mock ? 0 : RETRY_DELAY_MS)),
  })
}

// ---------- ingest ----------

/**
 * Parse the archive, store it in the vault (sha256-deduplicated), write canonical_profiles + work_profile memories,
 * then -> AVAILABLE with a summary in the event note. Parse failure -> retry/FAILED, nothing written.
 */
async function runIngest(q: Q, job: JobRow, bytes: Uint8Array, filename: string): Promise<JobRow> {
  let distilled: Distilled
  try {
    distilled = distil(snapshotFromZip(bytes), 'linkedin')
  } catch (err) {
    return failAttempt(q, job, `parse error: ${(err as Error).message}`, new Date())
  }

  const digest = sha256(bytes)
  const uri = await putObject(`linkedin/${job.user_id}/${digest}.zip`, bytes)
  const { rows } = await q.query<{ id: string; inserted: boolean }>(
    `INSERT INTO raw_vault_files (tenant_id, user_id, consent_grant_id, source_type, modality, storage_uri, sha256_checksum, sync_status)
     VALUES ($1, $2, $3, 'LINKEDIN_EXPORT', 'text', $4, $5, 'PROCESSING')
     ON CONFLICT (tenant_id, user_id, sha256_checksum) DO UPDATE SET sync_status = 'PROCESSING'
     RETURNING id, (xmax = 0) AS inserted`,
    [job.tenant_id, job.user_id, job.consent_grant_id, uri, digest],
  )
  const raw = rows[0]!

  await writeProfile(q, job, distilled, raw.id)
  const facts = await writeSkills(q, job, distilled, raw.id)
  await q.query(`UPDATE raw_vault_files SET sync_status = 'AVAILABLE' WHERE id = $1`, [raw.id])

  const summary: JobSummary = {
    roles: distilled.counts.positions,
    education: distilled.counts.education,
    skills: distilled.counts.skills,
    connections_count: distilled.social_graph_summary.connections_count,
    top_companies: distilled.social_graph_summary.top_companies,
    connections_stored_by_name: false,
    messages_skipped: true,
    raw_file_id: raw.id,
    deduplicated: !raw.inserted,
  }
  await ledger({
    tenantId: job.tenant_id,
    userId: job.user_id,
    consumerName: job.provider,
    operation: 'FACTS_INGESTED',
    scopesServed: ['work_profile'],
    recordsReturned: facts,
    detail: { job_id: job.id, filename, ...summary },
  })
  return transition(q, job, 'AVAILABLE', JSON.stringify(summary), { raw_file_id: raw.id, last_error: null })
}

async function writeProfile(q: Q, job: JobRow, d: Distilled, rawFileId: string) {
  const ext = { linkedin: { last_import_at: new Date().toISOString(), job_id: job.id, raw_file_id: rawFileId, provider: job.provider } }
  await q.query(
    `INSERT INTO canonical_profiles (tenant_id, user_id, identity_card, work_history, social_graph_summary, source_extensions, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       identity_card = canonical_profiles.identity_card || EXCLUDED.identity_card,
       work_history = EXCLUDED.work_history,
       social_graph_summary = EXCLUDED.social_graph_summary,
       source_extensions = canonical_profiles.source_extensions || EXCLUDED.source_extensions,
       updated_at = NOW()`,
    [job.tenant_id, job.user_id, JSON.stringify(d.identity_card), JSON.stringify(d.work_history), JSON.stringify(d.social_graph_summary), JSON.stringify(ext)],
  )
}

/**
 * Skills -> work_profile facts with provenance linkedin:Skills.csv#row. The archive is authoritative for LinkedIn
 * skills: previous LinkedIn skill facts are replaced, so a re-import (or an import after apply-drift) never leaves stale rows.
 */
async function writeSkills(q: Q, job: JobRow, d: Distilled, rawFileId: string): Promise<number> {
  await q.query(`DELETE FROM canonical_memories WHERE tenant_id = $1 AND user_id = $2 AND source_provenance_ref LIKE 'linkedin:Skills.csv#%'`, [job.tenant_id, job.user_id])
  let n = 0
  for (const s of d.skills) {
    const { rowCount } = await q.query(
      `INSERT INTO canonical_memories (tenant_id, user_id, raw_file_id, scope_category, fact_assertion, confidence_score, source_provider, source_provenance_ref, modality)
       VALUES ($1, $2, $3, $4, $5, 1.00, $6, $7, 'text')`,
      [job.tenant_id, job.user_id, rawFileId, s.category, s.fact, job.provider, s.provenance],
    )
    n += rowCount ?? 0
  }
  return n
}
