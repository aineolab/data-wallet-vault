// linkedin lane. Routes: POST /sources/linkedin/request, POST /sources/linkedin/confirm, POST /sources/linkedin/archive-ready,
// POST /ingest (zip upload, with job_id), POST /jobs/tick, GET /jobs, GET /jobs/:id, DELETE /grants/:id (revoke DATA_IN grant),
// POST /sources/linkedin/drift (read-only), POST /sources/linkedin/apply-drift.
// Logic lives in src/linkedin/ (mock provider, parser, state machine, drift). Contract: eval/linkedin_flow.py, eval/linkedin_drift.py.
import { Hono } from 'hono'
import { requireOwner } from '../auth.js'
import * as li from '../linkedin/index.js'

const linkedin = new Hono()

const json = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const b = await c.req.json()
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** wallet_request_linkedin_export */
linkedin.post('/sources/linkedin/request', requireOwner, async (c) => {
  const body = await json(c)
  const a = c.get('auth')
  const kind = body.archive_kind
  if (kind !== undefined && kind !== 'fast' && kind !== 'full') return c.json({ error: 'bad_request', message: 'archive_kind must be fast or full' }, 400)
  const out = await li.requestExport({ archive_kind: kind as string | undefined, mock_delay_s: body.mock_delay_s, mock_outcome: body.mock_outcome, tenantId: a.tenantId, userId: a.userId })
  return c.json(out)
})

/** The owner says "I clicked Request archive". */
linkedin.post('/sources/linkedin/confirm', requireOwner, async (c) => {
  const { job_id } = await json(c)
  if (typeof job_id !== 'string') return c.json({ error: 'bad_request', message: 'job_id required' }, 400)
  const job = await li.confirmRequested(job_id)
  if (!job) return c.json({ error: 'not_found', message: 'unknown job' }, 404)
  return c.json({ job_id: job.id, state: job.state })
})

/** wallet_archive_ready: the owner's agent saw LinkedIn's "your data is ready" email. */
linkedin.post('/sources/linkedin/archive-ready', requireOwner, async (c) => {
  const { job_id } = await json(c)
  if (typeof job_id !== 'string') return c.json({ error: 'bad_request', message: 'job_id required' }, 400)
  const job = await li.archiveReady(job_id)
  if (!job) return c.json({ error: 'not_found', message: 'unknown job' }, 404)
  return c.json({ job_id: job.id, state: job.state, archive_expires_at: job.archive_expires_at })
})

/**
 * wallet_deposit / POST /v1/ingest: multipart `file` (the LinkedIn zip) + `job_id`. Without a job_id a new
 * linkedin job is created for the deposit so the archive still gets a grant, a job and a ledger trail.
 */
linkedin.post('/ingest', requireOwner, async (c) => {
  const a = c.get('auth')
  const ct = c.req.header('content-type') ?? ''
  let bytes: Uint8Array | null = null
  let filename = 'upload.zip'
  let jobId: string | undefined
  if (ct.includes('multipart/form-data')) {
    const form = await c.req.formData()
    const f = form.get('file')
    if (f && typeof f === 'object' && 'arrayBuffer' in f) {
      bytes = new Uint8Array(await f.arrayBuffer())
      filename = (f as File).name || filename
    }
    const j = form.get('job_id')
    if (typeof j === 'string' && j) jobId = j
  } else {
    jobId = c.req.query('job_id') ?? undefined
    bytes = new Uint8Array(await c.req.arrayBuffer())
    filename = c.req.query('filename') ?? filename
  }
  if (!bytes?.byteLength) return c.json({ error: 'bad_request', message: 'multipart field `file` (zip) required' }, 400)
  if (!jobId) {
    const created = await li.requestExport({ archive_kind: 'fast', tenantId: a.tenantId, userId: a.userId })
    jobId = created.job_id
    await li.confirmRequested(jobId)
    await li.archiveReady(jobId)
  }
  const job = await li.deposit(jobId, bytes, filename)
  if (!job) return c.json({ error: 'not_found', message: 'unknown job' }, 404)
  const full = await li.getJob(job.id, a.tenantId, a.userId)
  return c.json({ job_id: job.id, raw_file_id: job.raw_file_id, state: job.state, last_error: job.last_error, summary: full?.summary ?? null })
})

/** Cron / tests: advance due jobs. */
linkedin.post('/jobs/tick', requireOwner, async (c) => {
  const body = await json(c)
  // A caller-supplied clock is honoured only in mock mode (tests); production always uses the real time.
  const now = li.isMock() && typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date()
  return c.json(await li.tick(now))
})

linkedin.get('/jobs', requireOwner, async (c) => {
  const a = c.get('auth')
  return c.json({ jobs: await li.listJobs(a.tenantId, a.userId) })
})

/** wallet_job_status */
linkedin.get('/jobs/:id', requireOwner, async (c) => {
  const a = c.get('auth')
  const job = await li.getJob(c.req.param('id'), a.tenantId, a.userId)
  if (!job) return c.json({ error: 'not_found', message: 'unknown job' }, 404)
  return c.json(job)
})

/** Revoke a DATA_IN grant: its job goes CANCELLED and the archive is never fetched. */
linkedin.delete('/grants/:id', requireOwner, async (c) => {
  const a = c.get('auth')
  const g = await li.revokeGrant(c.req.param('id'), a.tenantId, a.userId)
  if (!g) return c.json({ error: 'not_found', message: 'unknown DATA_IN grant' }, 404)
  return c.json({ grant_id: g.id, status: g.status, revoked_at: g.revoked_at })
})

/** wallet_linkedin_drift: read-only diff wallet vs live. */
linkedin.post('/sources/linkedin/drift', requireOwner, async (c) => {
  const a = c.get('auth')
  try {
    const out = await li.driftCheck(a.tenantId, a.userId)
    return c.json(out, 'error' in out ? 409 : 200)
  } catch (err) {
    if ((err as { code?: string }).code === 'NO_LIVE_SOURCE') return c.json({ error: 'NO_LIVE_SOURCE', message: (err as Error).message }, 409)
    throw err
  }
})

/** wallet_linkedin_apply_drift: the owner said yes. */
linkedin.post('/sources/linkedin/apply-drift', requireOwner, async (c) => {
  const a = c.get('auth')
  try {
    return c.json(await li.applyDrift(a.tenantId, a.userId))
  } catch (err) {
    if ((err as { code?: string }).code === 'NO_LIVE_SOURCE') return c.json({ error: 'NO_LIVE_SOURCE', message: (err as Error).message }, 409)
    throw err
  }
})

export default linkedin
