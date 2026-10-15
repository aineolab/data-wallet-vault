// Data Wallet server. One Hono app for every runtime:
//   Vercel     — zero-config: this default export is the function (Root Directory = server)
//   Node/Docker — src/node.ts wraps it with @hono/node-server
// Spec: ../CLAUDE.md. Phase 1 adds /mcp, /v1/*, /authorize, /token, /statement here.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config, publicUrl } from './config.js'
import { query } from './db.js'
import v1 from './v1/index.js'
import mcp from './mcp/index.js'

const app = new Hono()

// Dashboard (feature 12) reads /v1 with the owner bearer token from a Lovable origin.
app.use(
  '/v1/*',
  cors({
    origin: (origin) => {
      if (!origin) return null
      const allowed = config().DASHBOARD_ORIGIN
      if (allowed && origin === allowed.replace(/\/+$/, '')) return origin
      return /^https:\/\/[a-z0-9-]+\.lovable\.app$/i.test(origin) ? origin : null
    },
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
)

app.get('/', (c) =>
  c.json({
    name: 'data-wallet',
    docs: 'https://github.com/aineolab/data-wallet-vault',
    mcp: `${publicUrl(c.req.url)}/mcp`,
    health: `${publicUrl(c.req.url)}/health`,
  }),
)

app.get('/health', async (c) => {
  const cfg = config()
  try {
    const { rows } = await query<{ tables: string; migrations: string | null }>(
      `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')::text AS tables,
              (SELECT string_agg(version, ',' ORDER BY version)
                 FROM supabase_migrations.schema_migrations) AS migrations`,
    )
    const row = rows[0]
    return c.json({
      ok: true,
      db: 'ok',
      tables: Number(row?.tables ?? 0),
      migrations: row?.migrations?.split(',') ?? [],
      mock: { linkedin: cfg.MOCK_LINKEDIN === '1', web: cfg.MOCK_WEB === '1' },
      public_url: publicUrl(c.req.url),
    })
  } catch (err) {
    console.error('health: db check failed', (err as Error).message)
    return c.json({ ok: false, db: 'error' }, 503)
  }
})

// OAuth discovery (CLAUDE.md "OAuth"): unauthenticated /mcp points clients at the protected-resource metadata.
app.get('/.well-known/oauth-protected-resource', (c) => {
  const base = publicUrl(c.req.url)
  return c.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['work_profile', 'coding_preferences', 'shopping_preferences', 'personal_memory', 'offline_access'],
  })
})

app.route('/mcp', mcp)
app.route('/v1', v1)

app.notFound((c) => c.json({ error: 'not_found', path: new URL(c.req.url).pathname }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal', message: err.message }, 500)
})

export default app
