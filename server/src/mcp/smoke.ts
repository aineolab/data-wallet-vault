// mcp lane smoke test. Run against a local server:
//   cd server && PORT=3003 npm run dev        (terminal 1)
//   cd server && npx tsx --env-file=.env src/mcp/smoke.ts [http://localhost:3003]   (terminal 2)
// Inserts two short-lived tokens straight into the DB (consent_grants + data_out_tokens) using the core's
// newToken/hashToken, then exercises /mcp with the SDK client: (a) no token -> 401 + WWW-Authenticate,
// (b) owner token -> owner tool set + statement rows, (c) coding_preferences consumer -> two tools, facts for
// "indentation", and SCOPE_RESTRICTED for health_finance_restricted. Finally prints the `claude mcp add` commands.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { OWNER, hashToken, newToken } from '../auth.js'
import { db, query } from '../db.js'
import { ALL_SCOPES } from '../scopes.js'
import { CONSUMER_TOOLS, OWNER_TOOLS } from './tools.js'

const base = (process.argv[2] ?? 'http://localhost:3003').replace(/\/+$/, '')
const PUBLIC = 'https://data-wallet-server-five.vercel.app'
let failures = 0

function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`)
  if (!ok) failures++
}

async function issue(consumerName: string, consumerType: 'OWNER' | 'AI_AGENT_MCP', scopes: readonly string[]) {
  const token = newToken()
  const grant = await query<{ id: string }>(
    `INSERT INTO consent_grants (tenant_id, user_id, direction, counterparty, allowed_scopes, exclusive, status)
     VALUES ($1, $2, 'DATA_OUT', $3, $4::text[], FALSE, 'ACTIVE') RETURNING id`,
    [OWNER.tenantId, OWNER.userId, consumerName, scopes],
  )
  const grantId = grant.rows[0]!.id
  const tok = await query<{ id: string }>(
    `INSERT INTO data_out_tokens (tenant_id, user_id, consent_grant_id, consumer_name, consumer_type, token_hash, allowed_scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW() + INTERVAL '2 hours') RETURNING id`,
    [OWNER.tenantId, OWNER.userId, grantId, consumerName, consumerType, hashToken(token), scopes],
  )
  return { token, tokenId: tok.rows[0]!.id, grantId }
}

async function connect(token: string) {
  const client = new Client({ name: 'smoke', version: '0.0.1' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

function text(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const c = (result.content as Array<{ type: string; text?: string }>).find((x) => x.type === 'text')
  return c?.text ? (JSON.parse(c.text) as Record<string, unknown>) : {}
}

async function main() {
  // (a) no token
  const anon = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  check('no token -> 401', anon.status === 401, anon.status)
  const www = anon.headers.get('www-authenticate') ?? ''
  check('WWW-Authenticate points at protected-resource metadata', /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/.test(www), www)

  const health = (await (await fetch(`${base}/mcp/health`)).json()) as { ok: boolean; tools_owner: string[]; tools_consumer: string[] }
  check('/mcp/health lists both tool sets', health.ok && health.tools_owner.length === OWNER_TOOLS.length && health.tools_consumer.length === 2)

  // (b) owner
  const owner = await issue('smoke-owner', 'OWNER', ALL_SCOPES)
  const oc = await connect(owner.token)
  const ownerTools = (await oc.listTools()).tools.map((t) => t.name).sort()
  check('owner tools/list = owner set', JSON.stringify(ownerTools) === JSON.stringify([...OWNER_TOOLS].sort()), ownerTools)
  const stmt = text(await oc.callTool({ name: 'wallet_statement', arguments: {} }))
  const entries = stmt.entries as unknown[] | undefined
  check('wallet_statement returns rows', Array.isArray(entries) && entries.length > 0, { rows: entries?.length })
  const conns = text(await oc.callTool({ name: 'wallet_connections', arguments: {} }))
  check('wallet_connections lists the smoke owner token', (conns.connections as Array<{ token_id: string }>).some((x) => x.token_id === owner.tokenId))

  // (c) coding_preferences consumer
  const consumer = await issue('smoke-chatgpt', 'AI_AGENT_MCP', ['coding_preferences'])
  const cc = await connect(consumer.token)
  const consumerTools = (await cc.listTools()).tools
  check(
    'consumer tools/list = exactly the two consumer tools, readOnlyHint',
    JSON.stringify(consumerTools.map((t) => t.name).sort()) === JSON.stringify([...CONSUMER_TOOLS].sort()) &&
      consumerTools.every((t) => t.annotations?.readOnlyHint === true),
    consumerTools.map((t) => t.name),
  )
  const hit = text(await cc.callTool({ name: 'wallet_search_memories', arguments: { query: 'indentation' } }))
  const records = hit.records as Array<{ fact: string; category: string; provenance: string }>
  check('search "indentation" returns facts', records.length > 0, records.slice(0, 2))
  check('every record is coding_preferences with provenance', records.every((r) => r.category === 'coding_preferences' && !!r.provenance))
  const blocked = text(
    await cc.callTool({ name: 'wallet_search_memories', arguments: { query: 'mortgage', category: 'health_finance_restricted' } }),
  )
  check(
    'restricted category -> no records + SCOPE_RESTRICTED',
    (blocked.records as unknown[]).length === 0 && (blocked.notice as { code: string })?.code === 'SCOPE_RESTRICTED',
    blocked.notice,
  )
  const card = text(await cc.callTool({ name: 'wallet_get_identity_card', arguments: {} }))
  check('identity card without work_profile -> SCOPE_RESTRICTED', (card.notice as { code: string })?.code === 'SCOPE_RESTRICTED')

  // ledger rows written by the above
  const led = await query<{ operation: string; n: string }>(
    `SELECT operation, count(*)::text AS n FROM egress_ledger WHERE token_id = $1 GROUP BY operation`,
    [consumer.tokenId],
  )
  const ops = Object.fromEntries(led.rows.map((r) => [r.operation, Number(r.n)]))
  check('ledger: MCP_SEARCH_MEMORIES + SCOPE_BLOCKED rows for the consumer', (ops.MCP_SEARCH_MEMORIES ?? 0) >= 1 && (ops.SCOPE_BLOCKED ?? 0) >= 2, ops)

  // (d) revoke the consumer via the owner, next consumer call -> 401 WALLET_ACCESS_REVOKED
  const rev = text(await oc.callTool({ name: 'wallet_revoke', arguments: { token_id: consumer.tokenId } }))
  check('wallet_revoke', rev.revoked === true)
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${consumer.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  check('revoked consumer -> 401 WALLET_ACCESS_REVOKED', after.status === 401 && ((await after.json()) as { error: string }).error === 'WALLET_ACCESS_REVOKED')

  await oc.close()
  await cc.close().catch(() => {})
  // Clean up: revoke the smoke owner token too (rows stay; ledger is append-only by design).
  await query(`UPDATE data_out_tokens SET is_revoked = TRUE WHERE id = $1`, [owner.tokenId])
  await query(`UPDATE consent_grants SET status = 'REVOKED', revoked_at = NOW() WHERE id = $1`, [owner.grantId])

  console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILED`}\n`)
  console.log('Connect Claude Code (tokens from POST /v1/tokens/issue, or inserted like this script does):')
  console.log(`  claude mcp add --transport http data-wallet-owner ${PUBLIC}/mcp --header "Authorization: Bearer <OWNER_TOKEN>"`)
  console.log(`  claude mcp add --transport http data-wallet-coding ${PUBLIC}/mcp --header "Authorization: Bearer <CODING_PREFERENCES_CONSUMER_TOKEN>"`)
  await db().end()
  process.exit(failures ? 1 : 0)
}

main().catch(async (err) => {
  console.error('smoke crashed:', err)
  await db().end().catch(() => {})
  process.exit(1)
})
