// Snapshot the Normalizer's facts from canonical_memories into agents/out/<name>.json before a re-run wipes them.
//   cd agents && npm run dump -- run1 "note"
import fs from 'node:fs'
import pg from 'pg'

const [name = 'facts', note = ''] = process.argv.slice(2)
const url = process.env.DATABASE_URL
if (!url) throw new Error('missing env DATABASE_URL')
const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url)
const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } })
await client.connect()
try {
  const r = await client.query(
    `SELECT source_provenance_ref AS provenance, scope_category AS category, confidence_score::float AS confidence,
            fact_assertion AS fact, is_quarantined
       FROM canonical_memories WHERE source_provider = 'normalizer' ORDER BY 1, 4`,
  )
  fs.mkdirSync('out', { recursive: true })
  const path = `out/${name}-facts.json`
  fs.writeFileSync(path, JSON.stringify({ note, count: r.rowCount, facts: r.rows }, null, 1) + '\n')
  console.log(`${path}: ${r.rowCount} facts`)
} finally {
  await client.end()
}
