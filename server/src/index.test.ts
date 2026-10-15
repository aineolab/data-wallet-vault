import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(() => {
  // Minimal env so config() parses; nothing here opens a DB connection.
  process.env.DATABASE_URL ??= 'postgres://wallet:wallet@localhost:5433/wallet'
  process.env.OWNER_PASSPHRASE ??= 'test-passphrase-not-secret'
  process.env.PUBLIC_URL = 'https://wallet.example'
})

describe('server skeleton', () => {
  it('serves the index', async () => {
    const { default: app } = await import('./index.js')
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mcp).toBe('https://wallet.example/mcp')
  })

  it('answers unauthenticated /mcp with 401 + resource_metadata', async () => {
    const { default: app } = await import('./index.js')
    const res = await app.request('/mcp', { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://wallet.example/.well-known/oauth-protected-resource"',
    )
  })

  it('publishes protected-resource metadata with resource = PUBLIC_URL/mcp', async () => {
    const { default: app } = await import('./index.js')
    const res = await app.request('/.well-known/oauth-protected-resource')
    expect(res.status).toBe(200)
    expect((await res.json()).resource).toBe('https://wallet.example/mcp')
  })

  it('allows the dashboard origin on /v1 and refuses others', async () => {
    process.env.DASHBOARD_ORIGIN = 'https://id-preview--abc.lovable.app'
    const { default: app } = await import('./index.js')
    const ok = await app.request('/v1/ledger', { method: 'OPTIONS', headers: { Origin: 'https://id-preview--abc.lovable.app', 'Access-Control-Request-Method': 'GET' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://id-preview--abc.lovable.app')
    const no = await app.request('/v1/ledger', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } })
    expect(no.headers.get('access-control-allow-origin')).toBeNull()
  })
})
