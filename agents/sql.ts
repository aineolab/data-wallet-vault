// Tiny owner-side SQL runner for the normalizer lane's housekeeping (quarantine the seed fixture, inspect counts,
// delete local test rows). Reads DATABASE_URL from server/.env:  cd agents && npm run sql -- "SELECT ..."
import pg from 'pg'

const sql = process.argv.slice(2).join(' ').trim()
if (!sql) {
  console.error('usage: npm run sql -- "<statement>"')
  process.exit(2)
}
const url = process.env.DATABASE_URL
if (!url) throw new Error('missing env DATABASE_URL')
const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url)
const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } })
await client.connect()
try {
  const r = await client.query(sql)
  console.log(`${r.command} rowCount=${r.rowCount}`)
  if (r.rows.length) console.table(r.rows)
} finally {
  await client.end()
}
