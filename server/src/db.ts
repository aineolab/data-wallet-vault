// One pg Pool per process. On Vercel (Fluid compute) the module stays warm between requests, so the pool is reused.
// Token checks and scope filters hit Postgres on every request (non-negotiable 6): no caching layer lives here.
import pg from 'pg'
import { config } from './config.js'

let pool: pg.Pool | undefined

export function db(): pg.Pool {
  if (pool) return pool
  const url = config().DATABASE_URL
  const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url)
  pool = new pg.Pool({
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Supabase's pooler terminates TLS with its own chain; local docker Postgres has none.
    ssl: local ? undefined : { rejectUnauthorized: false },
  })
  pool.on('error', (err) => console.error('pg pool error', err.message))
  return pool
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  return db().query<T>(text, params)
}
