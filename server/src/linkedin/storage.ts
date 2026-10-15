// Raw archive storage for the linkedin lane: Supabase Storage bucket `vault` (service role, server env only),
// falling back to VAULT_DIR on disk when SUPABASE_URL is not configured (plain-Postgres self-host).
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config } from '../config.js'

export const BUCKET = 'vault'

let client: SupabaseClient | null | undefined
let bucketReady = false

function supabase(): SupabaseClient | null {
  if (client !== undefined) return client
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = config()
  client = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null
  return client
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function ensureBucket(sb: SupabaseClient) {
  if (bucketReady) return
  const { data } = await sb.storage.getBucket(BUCKET)
  if (!data) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false })
    // Another instance may have created it between our two calls.
    if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(`storage: create bucket failed: ${error.message}`)
  }
  bucketReady = true
}

/** Store bytes under a content-addressed path. Idempotent: the same bytes land at the same URI. Returns the storage URI. */
export async function putObject(path: string, bytes: Uint8Array, contentType = 'application/zip'): Promise<string> {
  const sb = supabase()
  if (sb) {
    await ensureBucket(sb)
    const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType, upsert: true })
    if (error) throw new Error(`storage: upload failed: ${error.message}`)
    return `supabase://${BUCKET}/${path}`
  }
  const dir = resolve(config().VAULT_DIR)
  const full = resolve(dir, path)
  await mkdir(resolve(full, '..'), { recursive: true })
  await writeFile(full, bytes)
  return `file://${full}`
}

export async function getObject(uri: string): Promise<Uint8Array> {
  if (uri.startsWith('file://')) return new Uint8Array(await readFile(uri.slice('file://'.length)))
  const m = /^supabase:\/\/([^/]+)\/(.+)$/.exec(uri)
  const sb = supabase()
  if (!m || !sb) throw new Error(`storage: cannot read ${uri}`)
  const { data, error } = await sb.storage.from(m[1]!).download(m[2]!)
  if (error || !data) throw new Error(`storage: download failed: ${error?.message ?? 'no data'}`)
  return new Uint8Array(await data.arrayBuffer())
}
