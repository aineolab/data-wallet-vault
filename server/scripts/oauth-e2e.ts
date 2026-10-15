// End-to-end OAuth check the way claude.ai does it: discovery -> DCR -> consent (POST the form) -> token (PKCE)
// -> MCP tools/list with the bearer -> refresh rotation -> old bearer rejected.
//   WALLET_URL=https://data-wallet-server-five.vercel.app OWNER_PASSPHRASE=... npx tsx scripts/oauth-e2e.ts [owner|consumer]
import { createHash, randomBytes } from 'node:crypto'

const BASE = (process.env.WALLET_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const PASS = process.env.OWNER_PASSPHRASE ?? ''
const ROLE = process.argv[2] === 'consumer' ? 'consumer' : 'owner'
const REDIRECT = 'http://localhost:6274/oauth/callback'
const b64url = (b: Buffer) => b.toString('base64url')
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  failures += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  ' + detail}`)
}

async function mcp(token: string, body: unknown) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: r.status === 200 ? await r.json() : await r.text() }
}

async function main() {
  if (!PASS) throw new Error('OWNER_PASSPHRASE env required')
  // 1. Discovery
  const unauth = await fetch(`${BASE}/mcp`, { method: 'POST' })
  check('401 + resource_metadata on /mcp', unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get('www-authenticate') ?? ''))
  const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json()
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()
  check('protected-resource resource = /mcp', pr.resource === `${BASE}/mcp`)
  check('AS metadata: S256, auth none, registration', as.code_challenge_methods_supported?.includes('S256') && as.token_endpoint_auth_methods_supported?.includes('none') && !!as.registration_endpoint)

  // 2. DCR
  const reg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: `e2e-${ROLE}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) })
  const client = await reg.json()
  check('DCR returns client_id', reg.status === 201 && typeof client.client_id === 'string', JSON.stringify(client))
  const bad = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'evil', redirect_uris: ['https://evil.example/cb'] }) })
  check('DCR rejects non-allowlisted redirect', bad.status === 400)

  // 3. Authorize: GET renders, POST approves
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(8))
  const authz = new URL(as.authorization_endpoint)
  Object.entries({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'coding_preferences work_profile' }).forEach(([k, v]) => authz.searchParams.set(k, v))
  const page = await fetch(authz)
  const htmlText = await page.text()
  check('consent page renders', page.status === 200 && /Approve/.test(htmlText) && /health_finance_restricted/.test(htmlText))
  const csrf = /name="csrf" value="([^"]+)"/.exec(htmlText)?.[1] ?? ''
  const form = new URLSearchParams({ csrf, role: ROLE, passphrase: PASS, decision: 'approve' })
  if (ROLE === 'consumer') form.append('scope', 'coding_preferences')
  const wrong = await fetch(authz, { method: 'POST', body: new URLSearchParams({ csrf, role: ROLE, passphrase: 'nope', decision: 'approve' }), redirect: 'manual' })
  check('wrong passphrase refused', wrong.status === 401)
  const approve = await fetch(authz, { method: 'POST', body: form, redirect: 'manual' })
  const loc = approve.headers.get('location') ?? ''
  const cb = loc ? new URL(loc) : null
  check('approve redirects with code + state', approve.status === 302 && !!cb?.searchParams.get('code') && cb?.searchParams.get('state') === state, `${approve.status} ${loc}`)
  const code = cb?.searchParams.get('code') ?? ''

  // 4. Token
  const tok = await fetch(as.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }) })
  const t = await tok.json()
  check('code -> access + refresh token', tok.status === 200 && typeof t.access_token === 'string' && typeof t.refresh_token === 'string', JSON.stringify(t))
  const replay = await fetch(as.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier }) })
  check('code is single-use', replay.status === 400)

  // 5. MCP with the bearer
  const list = await mcp(t.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  const names: string[] = list.status === 200 ? list.json.result.tools.map((x: { name: string }) => x.name) : []
  check(`tools/list as ${ROLE}`, ROLE === 'owner' ? names.includes('wallet_statement') : names.length === 2 && names.includes('wallet_search_memories'), JSON.stringify(list.json).slice(0, 200))
  const search = await mcp(t.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: ROLE === 'owner' ? 'wallet_search' : 'wallet_search_memories', arguments: { query: 'Dana', category: 'coding_preferences' } } })
  check('search returns coding_preferences records', search.status === 200 && /"provenance"/.test(JSON.stringify(search.json)))

  // 6. Refresh rotation
  const rt = await fetch(as.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id }) })
  const t2 = await rt.json()
  check('refresh -> new access + refresh', rt.status === 200 && t2.access_token && t2.access_token !== t.access_token && t2.refresh_token !== t.refresh_token, JSON.stringify(t2))
  const old = await mcp(t.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  check('old bearer rejected after rotation', old.status === 401)
  const nw = await mcp(t2.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
  check('new bearer works', nw.status === 200)
  const reuse = await fetch(as.token_endpoint, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id }) })
  check('spent refresh token rejected', reuse.status === 400)

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
