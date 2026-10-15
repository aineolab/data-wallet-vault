// exposure lane (feature 13). Owner-only routes (core requireOwner: no header = demo owner; a consumer token gets 403):
//   POST   /exposure/scan                 {subject?}            -> {scan_id, queries, exposures, skipped}   (403 SUBJECT_NOT_OWNER)
//   GET    /exposure                                            -> {exposures:[...]}
//   GET    /exposure/:id
//   POST   /exposure/:id/confirm          {is_me: bool}         -> the updated exposure ("that's me" / "not me")
//   GET    /owner-identifiers · POST {kind, value, verified_via?} · DELETE /owner-identifiers/:id
//   POST   /privacy-requests              {exposure_id, kind}   -> {request_id, state:'DRAFTED', draft_subject, draft_body, due_days}
//   GET    /privacy-requests                                    -> {requests:[...]}
//   GET    /privacy-requests/:id                                -> row + events (+ complaint_draft once ESCALATED)
//   POST   /privacy-requests/:id/sent     {gmail_draft_id?}     (the owner says "I sent it"; the wallet never sends)
//   POST   /privacy-requests/:id/event    {type: ack|data_received|completed|refused|withdrawn|extended}
//   POST   /privacy-requests/:id/:step    (same transitions as path segments)
//   POST   /privacy-requests/tick         {now?}                (mock clock honoured only with MOCK_WEB=1)
// Logic lives in src/exposure/ (mockweb.ts, scan.ts, requests.ts). Contract: eval/exposure_flow.py.
import { Hono } from 'hono'
import { requireOwner } from '../auth.js'
import { confirmExposure, scan, listExposures, getExposure, listIdentifiers, addIdentifier, removeIdentifier, subjectIsOwner } from '../exposure/scan.js'
import { KINDS, DUE_DAYS, RequestError, draftRequest, markSent, applyEvent, tick, getRequest, listRequests, describeRequest, type RequestKind, type EventType } from '../exposure/requests.js'

const exposure = new Hono()
// Scoped to this lane's paths only: the sub-app is mounted at /, so '*' would wrap other lanes' routes too.
for (const p of ['/exposure', '/exposure/*', '/owner-identifiers', '/owner-identifiers/*', '/privacy-requests', '/privacy-requests/*']) exposure.use(p, requireOwner)

const json = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const b = await c.req.json()
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const fail = (c: { json: (b: unknown, s: number) => Response }, err: unknown) => {
  if (err instanceof RequestError) return c.json({ error: err.code, message: err.message }, err.status)
  const e = err as { code?: string; message?: string }
  if (e?.code === 'WEB_SEARCH_NOT_CONFIGURED' || e?.code === 'NO_OWNER_IDENTIFIERS') return c.json({ error: e.code, message: e.message }, 503)
  throw err
}

// ---------------------------------------------------------------------------------------------------------------
// owner identifiers (scans may only use these)
// ---------------------------------------------------------------------------------------------------------------
const KINDS_ID = ['full_name', 'email', 'phone', 'username', 'city', 'employer']
const VERIFIED = ['owner_login', 'email_code', 'linkedin_profile', 'manual_attest']

exposure.get('/owner-identifiers', async (c) => {
  const a = c.get('auth')
  return c.json({ identifiers: await listIdentifiers(a.tenantId, a.userId) })
})

exposure.post('/owner-identifiers', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  const kind = String(b.kind ?? '')
  const value = String(b.value ?? '').trim()
  const via = String(b.verified_via ?? 'manual_attest')
  if (!KINDS_ID.includes(kind)) return c.json({ error: 'bad_request', message: `kind must be one of ${KINDS_ID.join(', ')}` }, 400)
  if (!value) return c.json({ error: 'bad_request', message: 'value required' }, 400)
  if (!VERIFIED.includes(via)) return c.json({ error: 'bad_request', message: `verified_via must be one of ${VERIFIED.join(', ')}` }, 400)
  return c.json({ identifier: await addIdentifier(a.tenantId, a.userId, kind, value, via) })
})

exposure.delete('/owner-identifiers/:id', async (c) => {
  const a = c.get('auth')
  const ok = await removeIdentifier(a.tenantId, a.userId, c.req.param('id'))
  return ok ? c.json({ deleted: true }) : c.json({ error: 'not_found', message: 'unknown identifier' }, 404)
})

// ---------------------------------------------------------------------------------------------------------------
// exposures
// ---------------------------------------------------------------------------------------------------------------
/** wallet_scan_exposure. Only the owner's own verified identifiers are ever searched. */
exposure.post('/exposure/scan', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  if (typeof b.subject === 'string' && b.subject.trim()) {
    const ids = await listIdentifiers(a.tenantId, a.userId)
    if (!subjectIsOwner(b.subject, ids))
      return c.json({ error: 'SUBJECT_NOT_OWNER', message: 'The wallet only scans for its owner. It never searches relatives, colleagues or namesakes.' }, 403)
  }
  try {
    return c.json(await scan(a.tenantId, a.userId))
  } catch (err) {
    return fail(c, err)
  }
})

/** wallet_exposures */
exposure.get('/exposure', async (c) => {
  const a = c.get('auth')
  return c.json({ exposures: await listExposures(a.tenantId, a.userId) })
})

exposure.get('/exposure/:id', async (c) => {
  const a = c.get('auth')
  const e = await getExposure(a.tenantId, a.userId, c.req.param('id'))
  return e ? c.json(e) : c.json({ error: 'not_found', message: 'unknown exposure' }, 404)
})

/** wallet_confirm_exposure: "that's me" (is_me true) or "not me" (false; never acted on again). */
exposure.post('/exposure/:id/confirm', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  if (typeof b.is_me !== 'boolean') return c.json({ error: 'bad_request', message: 'is_me (boolean) required' }, 400)
  const e = await confirmExposure(a.tenantId, a.userId, c.req.param('id'), b.is_me)
  return e ? c.json(e) : c.json({ error: 'not_found', message: 'unknown exposure' }, 404)
})

// ---------------------------------------------------------------------------------------------------------------
// privacy requests
// ---------------------------------------------------------------------------------------------------------------
const draftShape = (r: Awaited<ReturnType<typeof draftRequest>>) => ({
  request_id: r.id,
  exposure_id: r.exposure_id,
  kind: r.kind,
  state: r.state,
  channel: r.channel,
  draft_subject: r.draft_subject,
  draft_body: r.draft_body,
  due_days: DUE_DAYS,
  created_at: r.created_at,
})

/** wallet_draft_privacy_request */
exposure.post('/privacy-requests', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  const exposureId = String(b.exposure_id ?? '')
  const kind = String(b.kind ?? '') as RequestKind
  if (!exposureId) return c.json({ error: 'bad_request', message: 'exposure_id required' }, 400)
  if (!KINDS.includes(kind)) return c.json({ error: 'bad_request', message: `kind must be one of ${KINDS.join(', ')}` }, 400)
  try {
    return c.json(draftShape(await draftRequest(a.tenantId, a.userId, exposureId, kind)))
  } catch (err) {
    return fail(c, err)
  }
})

/** wallet_privacy_requests */
exposure.get('/privacy-requests', async (c) => {
  const a = c.get('auth')
  const rows = await listRequests(a.tenantId, a.userId)
  return c.json({ requests: rows.map((r) => ({ ...r, request_id: r.id, due_days: DUE_DAYS })) })
})

/** Deadlines. Production: cron every 30 s with no body. Mock clock `now` only with MOCK_WEB=1. */
exposure.post('/privacy-requests/tick', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  try {
    return c.json(await tick(a.tenantId, a.userId, typeof b.now === 'string' ? b.now : undefined))
  } catch (err) {
    return fail(c, err)
  }
})

exposure.get('/privacy-requests/:id', async (c) => {
  const a = c.get('auth')
  const r = await getRequest(a.tenantId, a.userId, c.req.param('id'))
  if (!r) return c.json({ error: 'not_found', message: 'unknown request' }, 404)
  return c.json(await describeRequest(a.tenantId, a.userId, r))
})

/** wallet_mark_request_sent: the owner pressed send in their own mail client. */
exposure.post('/privacy-requests/:id/sent', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  try {
    const r = await markSent(a.tenantId, a.userId, c.req.param('id'), {
      gmail_draft_id: typeof b.gmail_draft_id === 'string' ? b.gmail_draft_id : undefined,
      sent_at: typeof b.sent_at === 'string' ? b.sent_at : undefined,
    })
    return c.json(await describeRequest(a.tenantId, a.userId, r))
  } catch (err) {
    return fail(c, err)
  }
})

const STEPS: EventType[] = ['ack', 'data_received', 'completed', 'refused', 'withdrawn', 'extended']

exposure.post('/privacy-requests/:id/event', async (c) => {
  const a = c.get('auth')
  const b = await json(c)
  const type = String(b.type ?? '') as EventType
  if (!STEPS.includes(type)) return c.json({ error: 'bad_request', message: `type must be one of ${STEPS.join(', ')}` }, 400)
  try {
    const r = await applyEvent(a.tenantId, a.userId, c.req.param('id'), type, typeof b.note === 'string' ? b.note : undefined)
    return c.json(await describeRequest(a.tenantId, a.userId, r))
  } catch (err) {
    return fail(c, err)
  }
})

/** Same transitions as path segments: POST /privacy-requests/:id/ack etc. */
exposure.post('/privacy-requests/:id/:step', async (c) => {
  const a = c.get('auth')
  const step = c.req.param('step') as EventType
  if (!STEPS.includes(step)) return c.json({ error: 'not_found', message: `unknown step; use one of sent, event, ${STEPS.join(', ')}` }, 404)
  const b = await json(c)
  try {
    const r = await applyEvent(a.tenantId, a.userId, c.req.param('id'), step, typeof b.note === 'string' ? b.note : undefined)
    return c.json(await describeRequest(a.tenantId, a.userId, r))
  } catch (err) {
    return fail(c, err)
  }
})

export default exposure
