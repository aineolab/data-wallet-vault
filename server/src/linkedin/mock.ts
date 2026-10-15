// Mock LinkedIn provider (MOCK_LINKEDIN=1, provider = linkedin_mock). Same state machine as the real flow; the
// "archive" becomes ready after `mock_delay_s` and is seed/out/linkedin/*.zip. `mock_outcome` drives failure tests:
//   ok       the seed archive, parses cleanly
//   expired  the download window has already closed when the archive is "ready" -> EXPIRED
//   corrupt  bytes that are not a zip -> parse error -> retries -> FAILED
// The live-API mock serves seed/out/linkedin/api_snapshot.json in the DMA response shape.
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'
import { ALLOWLIST, snapshotFromApi, type Domain, type Snapshot } from './parse.js'

export type MockOutcome = 'ok' | 'expired' | 'corrupt'
export interface MockKnobs {
  mock_delay_s: number
  mock_outcome: MockOutcome
}

export const isMock = () => config().MOCK_LINKEDIN === '1'

export const ARCHIVE_NAME = 'Basic_LinkedInDataExport_10-15-2026.zip'
const SEED_DIR = 'seed/out/linkedin'
// Vercel has no seed/ (Root Directory = server): the files are served from server/public as static assets.
const RAW_BASE = (process.env.MOCK_LINKEDIN_SEED_URL ?? 'https://raw.githubusercontent.com/aineolab/data-wallet-vault/main').replace(/\/+$/, '')

/** Request-body knobs, honoured only in mock mode. */
export function mockKnobs(body: Record<string, unknown> | undefined): MockKnobs {
  const d = Number(body?.mock_delay_s)
  const o = String(body?.mock_outcome ?? 'ok')
  return {
    mock_delay_s: Number.isFinite(d) && d >= 0 ? d : 60,
    mock_outcome: o === 'expired' || o === 'corrupt' ? o : 'ok',
  }
}

/** Serialise knobs into source_jobs.external_ref (the "provider request id" slot). */
export const encodeKnobs = (k: MockKnobs) => `mock:${JSON.stringify(k)}`
export function decodeKnobs(externalRef: string | null): MockKnobs {
  if (!externalRef?.startsWith('mock:')) return { mock_delay_s: 60, mock_outcome: 'ok' }
  try {
    return mockKnobs(JSON.parse(externalRef.slice(5)))
  } catch {
    return { mock_delay_s: 60, mock_outcome: 'ok' }
  }
}

function seedCandidates(name: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    process.env.MOCK_LINKEDIN_SEED_DIR ? resolve(process.env.MOCK_LINKEDIN_SEED_DIR, name) : '',
    resolve(process.cwd(), SEED_DIR, name), // repo root
    resolve(process.cwd(), '..', SEED_DIR, name), // cwd = server/
    resolve(here, '../../..', SEED_DIR, name), // from server/src/linkedin or server/dist/linkedin
    resolve(here, '../../../..', SEED_DIR, name),
  ].filter(Boolean)
}

/** Read a seed file from disk, or from the public repo when the deployment (Vercel, Root Directory = server) lacks seed/. */
async function seedFile(name: string): Promise<Uint8Array> {
  for (const p of seedCandidates(name)) if (existsSync(p)) return new Uint8Array(await readFile(p))
  const res = await fetch(process.env.MOCK_LINKEDIN_SEED_URL ? `${RAW_BASE}/${name}` : `${RAW_BASE}/${SEED_DIR}/${name}`)
  if (!res.ok) throw new Error(`mock: seed file ${name} not found locally or at ${RAW_BASE}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** The archive bytes the mock "download" returns. `expired` never gets here (the job expires first). */
export async function mockArchive(outcome: MockOutcome): Promise<{ filename: string; bytes: Uint8Array }> {
  if (outcome === 'corrupt') {
    // Looks like a zip to a naive check (PK header) but has no central directory: fflate throws.
    const junk = new Uint8Array(512)
    junk.set([0x50, 0x4b, 0x03, 0x04])
    for (let i = 4; i < junk.length; i++) junk[i] = (i * 37 + 11) & 0xff
    return { filename: 'corrupt.zip', bytes: junk }
  }
  return { filename: ARCHIVE_NAME, bytes: await seedFile(ARCHIVE_NAME) }
}

/** Mock DMA API: `memberSnapshotData?q=criteria&domain=X` for every allowlisted domain, from api_snapshot.json. */
export async function mockLiveSnapshot(): Promise<Snapshot> {
  const raw = JSON.parse(new TextDecoder().decode(await seedFile('api_snapshot.json'))) as Record<string, unknown>
  const snap: Snapshot = {}
  for (const d of ALLOWLIST) {
    const body = raw[d]
    if (body === undefined) continue
    // The seed file stores `{DOMAIN: rows[]}`; a real response is `{elements:[{snapshotData: rows[]}]}`. Both parse.
    snap[d as Domain] = snapshotFromApi(d, body)
  }
  return snap
}
