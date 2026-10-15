// TEMPORARY demo fixture: loads every fact in seed/out/answer_key.json into canonical_memories so the wallet has
// data before the Normalizer runs. Idempotent: a second run is a no-op.
//   cd server && npx tsx --env-file=.env scripts/seed-fixture.ts
// Rows are tagged source_provider = 'seed_fixture' under a DATA_IN grant with counterparty 'seed_fixture'.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OWNER } from '../src/auth.js'
import { db, query } from '../src/db.js'
import { isScope } from '../src/scopes.js'

const here = dirname(fileURLToPath(import.meta.url))
const keyPath = resolve(here, '../../seed/out/answer_key.json')
const PROVIDER = 'seed_fixture'

interface Fact {
  category: string
  fact: string
  provenance: string
}

async function main() {
  const raw = readFileSync(keyPath)
  const key = JSON.parse(raw.toString('utf8')) as { facts: Fact[] }
  const sha256 = createHash('sha256').update(raw).digest('hex')

  const existing = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM canonical_memories WHERE tenant_id = $1 AND user_id = $2 AND source_provider = $3`,
    [OWNER.tenantId, OWNER.userId, PROVIDER],
  )
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    console.log(`seed-fixture: ${existing.rows[0]!.n} ${PROVIDER} rows already present, skipping`)
    return
  }

  const client = await db().connect()
  try {
    await client.query('BEGIN')
    const grant = await client.query<{ id: string }>(
      `INSERT INTO consent_grants (tenant_id, user_id, direction, counterparty, allowed_scopes, exclusive, status)
       VALUES ($1, $2, 'DATA_IN', $3, $4::text[], FALSE, 'ACTIVE') RETURNING id`,
      [OWNER.tenantId, OWNER.userId, PROVIDER, [...new Set(key.facts.map((f) => f.category))]],
    )
    const grantId = grant.rows[0]!.id
    const file = await client.query<{ id: string }>(
      `INSERT INTO raw_vault_files (tenant_id, user_id, consent_grant_id, source_type, modality, storage_uri, sha256_checksum, sync_status)
       VALUES ($1, $2, $3, 'CHATGPT_EXPORT', 'text', 'seed://answer_key', $4, 'AVAILABLE')
       ON CONFLICT (tenant_id, user_id, sha256_checksum) DO UPDATE SET sync_status = 'AVAILABLE'
       RETURNING id`,
      [OWNER.tenantId, OWNER.userId, grantId, sha256],
    )
    const fileId = file.rows[0]!.id

    let inserted = 0
    let skipped = 0
    for (const f of key.facts) {
      if (!isScope(f.category) || !f.fact || !f.provenance) {
        skipped++
        continue
      }
      await client.query(
        `INSERT INTO canonical_memories
           (tenant_id, user_id, raw_file_id, scope_category, fact_assertion, confidence_score, source_provider, source_provenance_ref, modality)
         VALUES ($1, $2, $3, $4, $5, 1.00, $6, $7, 'text')`,
        [OWNER.tenantId, OWNER.userId, fileId, f.category, f.fact, PROVIDER, f.provenance],
      )
      inserted++
    }
    await client.query('COMMIT')
    console.log(`seed-fixture: inserted ${inserted} facts (skipped ${skipped}); grant ${grantId}, raw file ${fileId}, sha256 ${sha256.slice(0, 12)}…`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

main()
  .then(() => db().end())
  .catch((err) => {
    console.error('seed-fixture failed:', (err as Error).message)
    process.exit(1)
  })
