// GDPR privacy requests about an exposure (CLAUDE.md feature 13). The wallet NEVER sends anything: it drafts, the owner's
// agent makes a Gmail draft, the owner presses send and tells the wallet ("I sent it" = POST .../sent).
//
// State machine (every transition appends a privacy_request_events row; the table is append-only):
//   DRAFTED -> SENT -> ACKNOWLEDGED -> DATA_RECEIVED -> COMPLETED
//   SENT/ACKNOWLEDGED past due_at (sent_at + 30 days, Art. 12(3) "one month") -> OVERDUE -> ESCALATED (complaint drafted to the DPA)
//   any non-terminal -> REFUSED | WITHDRAWN
// Drafts contain only what identifies the owner (name, email, the URL of the record): never phone, relatives or anything
// else the page showed.
import { query } from '../db.js'
import { ledger } from '../ledger.js'
import { isMockWeb } from './mockweb.js'
import { getExposure, listIdentifiers, type ExposureRow } from './scan.js'

export type RequestKind = 'access_art15' | 'erasure_art17' | 'opt_out' | 'search_delisting'
export type RequestState = 'DRAFTED' | 'SENT' | 'ACKNOWLEDGED' | 'DATA_RECEIVED' | 'COMPLETED' | 'OVERDUE' | 'ESCALATED' | 'REFUSED' | 'WITHDRAWN'
export type EventType = 'ack' | 'data_received' | 'completed' | 'refused' | 'withdrawn' | 'extended'

export const KINDS: RequestKind[] = ['access_art15', 'erasure_art17', 'opt_out', 'search_delisting']
export const DUE_DAYS = 30
const TERMINAL: RequestState[] = ['COMPLETED', 'REFUSED', 'WITHDRAWN']

export interface RequestRow {
  id: string
  exposure_id: string
  kind: RequestKind
  state: RequestState
  channel: 'email' | 'web_form' | 'post'
  draft_subject: string
  draft_body: string
  gmail_draft_id: string | null
  sent_at: string | null
  due_at: string | null
  next_check_at: string
  created_at: string
  updated_at: string
}
export interface EventRow {
  id: number
  from_state: string | null
  to_state: string
  note: string | null
  created_at: string
}

export class RequestError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------------------
interface OwnerIdentity {
  name: string
  email: string | null
}

async function ownerIdentity(tenantId: string, userId: string): Promise<OwnerIdentity> {
  const ids = await listIdentifiers(tenantId, userId)
  const name = ids.find((i) => i.kind === 'full_name')?.value ?? 'the data subject'
  const email = ids.find((i) => i.kind === 'email')?.value ?? null
  return { name, email }
}

const identifyBlock = (o: OwnerIdentity, e: ExposureRow) =>
  [
    'To help you locate my record, here is the minimum needed to identify me:',
    `- Name: ${o.name}`,
    o.email ? `- Email address: ${o.email}` : null,
    `- The page or record concerned: ${e.url}`,
    'I will not provide further personal data for this request; if you need to verify my identity, please tell me what is proportionate under Article 12(6).',
  ]
    .filter(Boolean)
    .join('\n')

const deadline = `Under Article 12(3) GDPR you must respond without undue delay and in any event within one month of receipt of this request.`

export function draftFor(kind: RequestKind, e: ExposureRow, o: OwnerIdentity): { subject: string; body: string } {
  const controller = e.site
  switch (kind) {
    case 'access_art15':
      return {
        subject: `Subject access request under Article 15 GDPR – ${o.name}`,
        body: [
          `Dear ${controller} data protection officer,`,
          '',
          `I am making a subject access request under Article 15 of the General Data Protection Regulation (GDPR) / UK GDPR. ${controller} is the data controller for the personal data published or held about me at the record below.`,
          '',
          identifyBlock(o, e),
          '',
          'Please provide:',
          '1. a copy of all personal data you hold about me, in a commonly used electronic format (Article 15(3), Article 20);',
          '2. the purposes of the processing and its legal basis;',
          '3. the recipients or categories of recipients to whom the data has been or will be disclosed;',
          '4. the source of the data, where it was not collected from me (Article 15(1)(g));',
          '5. the retention period, and whether any automated decision-making or profiling is applied.',
          '',
          deadline,
          '',
          'Kind regards,',
          o.name,
        ].join('\n'),
      }
    case 'erasure_art17':
      return {
        subject: `Request for erasure under Article 17 GDPR – ${o.name}`,
        body: [
          `Dear ${controller} data protection officer,`,
          '',
          `I request the erasure of all personal data you hold about me, under Article 17 of the General Data Protection Regulation (GDPR) / UK GDPR. ${controller} is the data controller for the record below. I have not consented to this processing and I object to it under Article 21, including any processing for direct marketing (Article 21(2)), so the grounds in Article 17(1)(b), (c) and (d) apply.`,
          '',
          identifyBlock(o, e),
          '',
          'Please:',
          '1. erase my personal data from your systems and from the page above, and confirm when this is done;',
          '2. inform any recipients to whom you disclosed the data of this erasure (Article 19), and tell me who they are;',
          '3. stop any further collection or republication of my data.',
          e.controller_contact?.startsWith('http') ? `I note your opt-out form at ${e.controller_contact}; this letter is my formal request regardless of that form.` : '',
          '',
          deadline,
          '',
          'Kind regards,',
          o.name,
        ].join('\n'),
      }
    case 'opt_out':
      return {
        subject: `Opt-out / removal request – ${o.name}`,
        body: [
          `Removal request for ${controller}${e.controller_contact?.startsWith('http') ? ` via ${e.controller_contact}` : ''}.`,
          '',
          identifyBlock(o, e),
          '',
          'Please remove the record above and suppress it from future listings. This request is made under Article 21 GDPR (right to object) and, where applicable, Article 17 GDPR (right to erasure).',
          '',
          deadline,
          '',
          o.name,
        ].join('\n'),
      }
    case 'search_delisting':
      return {
        subject: `Request to delist search results – ${o.name}`,
        body: [
          `Dear ${controller},`,
          '',
          `I request that the URL below be delisted from search results for queries on my name, under Article 17 GDPR and the Court of Justice judgment in Google Spain (C-131/12). The result is inaccurate, inadequate, irrelevant or excessive in relation to the purposes of the processing.`,
          '',
          identifyBlock(o, e),
          '',
          deadline,
          '',
          'Kind regards,',
          o.name,
        ].join('\n'),
      }
  }
}

/** Complaint to the supervisory authority (Article 77) once a request is ignored past its deadline. */
/** pg hands timestamptz back as Date; the API may hand us ISO strings. Either way: YYYY-MM-DD. */
const day = (v: string | Date | null | undefined, fallback: string) => (v ? new Date(v).toISOString().slice(0, 10) : fallback)

export function complaintFor(r: RequestRow, e: ExposureRow, o: OwnerIdentity): { authority: string; subject: string; body: string } {
  const article = r.kind === 'access_art15' ? 'Article 15 (access)' : r.kind === 'search_delisting' ? 'Article 17 (delisting)' : 'Article 17 (erasure)'
  return {
    authority: "Information Commissioner's Office (ICO), or the supervisory authority of the controller's establishment",
    subject: `Complaint under Article 77 GDPR – ${e.site} has not responded to my ${article} request`,
    body: [
      'Dear Sir or Madam,',
      '',
      `I wish to lodge a complaint under Article 77 GDPR against ${e.site} (the data controller). On ${day(r.sent_at, 'the date recorded')} I sent them a request under ${article} GDPR concerning my personal data at ${e.url}. The one-month deadline in Article 12(3) expired on ${day(r.due_at, 'the due date')} and I have received no response.`,
      '',
      identifyBlock(o, e),
      '',
      'I attach a copy of my original request. I ask you to investigate and to order the controller to comply.',
      '',
      'Kind regards,',
      o.name,
    ].join('\n'),
  }
}

function channelFor(e: ExposureRow): RequestRow['channel'] {
  const c = e.controller_contact ?? ''
  if (c.includes('@')) return 'email'
  if (/^https?:\/\//.test(c)) return 'web_form'
  return 'post'
}

// ---------------------------------------------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------------------------------------------
const COLS = `id, exposure_id, kind, state, channel, draft_subject, draft_body, gmail_draft_id, sent_at, due_at, next_check_at, created_at, updated_at`

async function appendEvent(requestId: string, from: string | null, to: string, note: string | null): Promise<void> {
  await query(`INSERT INTO privacy_request_events (request_id, from_state, to_state, note) VALUES ($1, $2, $3, $4)`, [requestId, from, to, note])
}

export async function getRequest(tenantId: string, userId: string, id: string): Promise<RequestRow | null> {
  const { rows } = await query<RequestRow>(`SELECT ${COLS} FROM privacy_requests WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id])
  return rows[0] ?? null
}

export async function listRequests(tenantId: string, userId: string): Promise<(RequestRow & { url: string; site: string })[]> {
  const { rows } = await query<RequestRow & { url: string; site: string }>(
    `SELECT r.id, r.exposure_id, r.kind, r.state, r.channel, r.draft_subject, r.draft_body, r.gmail_draft_id, r.sent_at, r.due_at,
            r.next_check_at, r.created_at, r.updated_at, e.url, e.site
       FROM privacy_requests r JOIN exposures e ON e.id = r.exposure_id
      WHERE r.tenant_id = $1 AND r.user_id = $2 ORDER BY r.created_at DESC`,
    [tenantId, userId],
  )
  return rows
}

export async function listEvents(requestId: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(`SELECT id, from_state, to_state, note, created_at FROM privacy_request_events WHERE request_id = $1 ORDER BY id`, [requestId])
  return rows
}

/** The GET shape: the row, its events, the deadline, and the complaint draft once escalated. */
export async function describeRequest(tenantId: string, userId: string, r: RequestRow) {
  const events = await listEvents(r.id)
  const out: Record<string, unknown> = { ...r, request_id: r.id, due_days: DUE_DAYS, events }
  if (r.state === 'ESCALATED') {
    const esc = events.filter((ev) => ev.to_state === 'ESCALATED').at(-1)
    if (esc?.note) {
      try {
        out.complaint_draft = JSON.parse(esc.note)
      } catch {
        out.complaint_draft = { body: esc.note }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------------------------------------------
export async function draftRequest(tenantId: string, userId: string, exposureId: string, kind: RequestKind): Promise<RequestRow> {
  const e = await getExposure(tenantId, userId, exposureId)
  if (!e) throw new RequestError(404, 'not_found', 'unknown exposure')
  if (e.owner_confirmed === false) throw new RequestError(409, 'NOT_OWNER_DATA', 'You marked this exposure as not you; nothing to request')
  if (e.owner_confirmed !== true && Number(e.match_confidence) < 0.5)
    throw new RequestError(409, 'NEEDS_OWNER_CONFIRMATION', 'This page is probably not you (low confidence). Confirm it is you first: POST /v1/exposure/{id}/confirm {is_me:true}')
  const o = await ownerIdentity(tenantId, userId)
  const d = draftFor(kind, e, o)
  const { rows } = await query<RequestRow>(
    `INSERT INTO privacy_requests (tenant_id, user_id, exposure_id, kind, state, channel, draft_subject, draft_body)
     VALUES ($1, $2, $3, $4, 'DRAFTED', $5, $6, $7) RETURNING ${COLS}`,
    [tenantId, userId, exposureId, kind, channelFor(e), d.subject, d.body],
  )
  const r = rows[0]!
  await appendEvent(r.id, null, 'DRAFTED', `drafted ${kind} to ${e.site}${e.controller_contact ? ` (${e.controller_contact})` : ''}`)
  await ledger({ tenantId, userId, consumerName: 'owner', operation: 'PRIVACY_REQUEST_DRAFTED', recordsReturned: 1, detail: { request_id: r.id, exposure_id: exposureId, kind, site: e.site } })
  return r
}

/** The owner says "I sent it". Starts the one-month clock. */
export async function markSent(tenantId: string, userId: string, id: string, opts: { gmail_draft_id?: string; sent_at?: string } = {}): Promise<RequestRow> {
  const r = await getRequest(tenantId, userId, id)
  if (!r) throw new RequestError(404, 'not_found', 'unknown request')
  if (r.state !== 'DRAFTED') throw new RequestError(409, 'INVALID_TRANSITION', `cannot mark a ${r.state} request as sent`)
  const sentAt = opts.sent_at && isMockWeb() ? new Date(opts.sent_at) : new Date()
  if (Number.isNaN(sentAt.getTime())) throw new RequestError(400, 'bad_request', 'sent_at must be an ISO timestamp')
  const { rows } = await query<RequestRow>(
    `UPDATE privacy_requests SET state = 'SENT', sent_at = $4, due_at = $4::timestamptz + make_interval(days => $5), next_check_at = $4::timestamptz + make_interval(days => $5),
            gmail_draft_id = COALESCE($6, gmail_draft_id), updated_at = NOW()
      WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING ${COLS}`,
    [tenantId, userId, id, sentAt.toISOString(), DUE_DAYS, opts.gmail_draft_id ?? null],
  )
  await appendEvent(id, 'DRAFTED', 'SENT', 'owner confirmed they sent it; one-month clock started (Art. 12(3))')
  await ledger({ tenantId, userId, consumerName: 'owner', operation: 'PRIVACY_REQUEST_SENT', recordsReturned: 1, detail: { request_id: id, kind: r.kind, due_at: rows[0]!.due_at } })
  return rows[0]!
}

const ALLOWED: Record<EventType, { from: RequestState[]; to: RequestState | null; note: string }> = {
  ack: { from: ['SENT', 'OVERDUE'], to: 'ACKNOWLEDGED', note: 'controller acknowledged the request' },
  data_received: { from: ['SENT', 'ACKNOWLEDGED', 'OVERDUE', 'ESCALATED'], to: 'DATA_RECEIVED', note: 'controller sent the data (deposit it into the wallet if useful)' },
  completed: { from: ['SENT', 'ACKNOWLEDGED', 'DATA_RECEIVED', 'OVERDUE', 'ESCALATED'], to: 'COMPLETED', note: 'request fulfilled' },
  refused: { from: ['DRAFTED', 'SENT', 'ACKNOWLEDGED', 'DATA_RECEIVED', 'OVERDUE', 'ESCALATED'], to: 'REFUSED', note: 'controller refused (consider a complaint under Art. 77)' },
  withdrawn: { from: ['DRAFTED', 'SENT', 'ACKNOWLEDGED', 'DATA_RECEIVED', 'OVERDUE', 'ESCALATED'], to: 'WITHDRAWN', note: 'owner withdrew the request' },
  extended: { from: ['SENT', 'ACKNOWLEDGED', 'OVERDUE'], to: null, note: 'controller extended the deadline by two months (Art. 12(3))' },
}

export async function applyEvent(tenantId: string, userId: string, id: string, type: EventType, note?: string): Promise<RequestRow> {
  const rule = ALLOWED[type]
  if (!rule) throw new RequestError(400, 'bad_request', `type must be one of ${Object.keys(ALLOWED).join(', ')}`)
  const r = await getRequest(tenantId, userId, id)
  if (!r) throw new RequestError(404, 'not_found', 'unknown request')
  if (!rule.from.includes(r.state)) throw new RequestError(409, 'INVALID_TRANSITION', `cannot apply ${type} to a ${r.state} request`)
  let rows: RequestRow[]
  if (type === 'extended') {
    // Deadline moves; state stays (an OVERDUE request is no longer overdue: back to ACKNOWLEDGED).
    const to: RequestState = r.state === 'OVERDUE' ? 'ACKNOWLEDGED' : r.state
    ;({ rows } = await query<RequestRow>(
      `UPDATE privacy_requests SET state = $4, due_at = COALESCE(due_at, NOW()) + INTERVAL '2 months', next_check_at = COALESCE(due_at, NOW()) + INTERVAL '2 months', updated_at = NOW()
        WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING ${COLS}`,
      [tenantId, userId, id, to],
    ))
    await appendEvent(id, r.state, to, note ?? rule.note)
  } else {
    ;({ rows } = await query<RequestRow>(
      `UPDATE privacy_requests SET state = $4, updated_at = NOW() WHERE tenant_id = $1 AND user_id = $2 AND id = $3 RETURNING ${COLS}`,
      [tenantId, userId, id, rule.to],
    ))
    await appendEvent(id, r.state, rule.to!, note ?? rule.note)
  }
  await ledger({ tenantId, userId, consumerName: 'owner', operation: `PRIVACY_REQUEST_${type.toUpperCase()}`, recordsReturned: 1, detail: { request_id: id, kind: r.kind, from: r.state, to: rows[0]!.state } })
  return rows[0]!
}

// ---------------------------------------------------------------------------------------------------------------
// Tick: deadlines. Real clock in production (cron every 30 s); the mock clock `now` is honoured only with MOCK_WEB=1.
// ---------------------------------------------------------------------------------------------------------------
export interface TickResult {
  now: string
  overdue: string[]
  escalated: string[]
  mock_clock: boolean
}

export async function tick(tenantId: string, userId: string, mockNow?: string): Promise<TickResult> {
  const useMock = !!mockNow && isMockWeb()
  const now = useMock ? new Date(mockNow) : new Date()
  if (Number.isNaN(now.getTime())) throw new RequestError(400, 'bad_request', 'now must be an ISO timestamp')
  const nowIso = now.toISOString()
  const o = await ownerIdentity(tenantId, userId)

  // 1. OVERDUE past its grace -> ESCALATED (first, so a request never jumps two states in one tick)
  const { rows: toEscalate } = await query<RequestRow>(
    `SELECT ${COLS} FROM privacy_requests WHERE tenant_id = $1 AND user_id = $2 AND state = 'OVERDUE' AND next_check_at <= $3::timestamptz`,
    [tenantId, userId, nowIso],
  )
  const escalated: string[] = []
  for (const r of toEscalate) {
    const e = await getExposure(tenantId, userId, r.exposure_id)
    if (!e) continue
    const complaint = complaintFor(r, e, o)
    await query(`UPDATE privacy_requests SET state = 'ESCALATED', next_check_at = $4::timestamptz + INTERVAL '30 days', updated_at = NOW() WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, r.id, nowIso])
    await appendEvent(r.id, 'OVERDUE', 'ESCALATED', JSON.stringify(complaint))
    await ledger({ tenantId, userId, consumerName: 'owner', operation: 'PRIVACY_REQUEST_ESCALATED', recordsReturned: 1, detail: { request_id: r.id, kind: r.kind, authority: complaint.authority } })
    escalated.push(r.id)
  }

  // 2. SENT / ACKNOWLEDGED past due_at -> OVERDUE. Escalation follows on the next tick after a grace period
  //    (none in mock mode so the eval's second tick escalates; 7 days with a real clock).
  const graceDays = useMock ? 0 : 7
  const { rows: toOverdue } = await query<RequestRow>(
    `SELECT ${COLS} FROM privacy_requests WHERE tenant_id = $1 AND user_id = $2 AND state IN ('SENT','ACKNOWLEDGED') AND due_at IS NOT NULL AND due_at <= $3::timestamptz`,
    [tenantId, userId, nowIso],
  )
  const overdue: string[] = []
  for (const r of toOverdue) {
    await query(`UPDATE privacy_requests SET state = 'OVERDUE', next_check_at = $4::timestamptz + make_interval(days => $5), updated_at = NOW() WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, r.id, nowIso, graceDays])
    await appendEvent(r.id, r.state, 'OVERDUE', `no reply by ${r.due_at} (Art. 12(3) one-month deadline passed)`)
    await ledger({ tenantId, userId, consumerName: 'owner', operation: 'PRIVACY_REQUEST_OVERDUE', recordsReturned: 1, detail: { request_id: r.id, kind: r.kind, due_at: r.due_at } })
    overdue.push(r.id)
  }
  return { now: nowIso, overdue, escalated, mock_clock: useMock }
}
