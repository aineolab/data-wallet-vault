// mcp lane. One endpoint, streamable HTTP, STATELESS (no session ids); tools/list filtered by token type
// (CLAUDE.md "MCP tools"). Web-standard Request/Response so the same code runs on Vercel functions and Node.
// A fresh McpServer + transport is built per request: nothing is cached, so revocation bites on the next call.
import { Hono, type Context } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { bearer, isFailure, resolveToken } from '../auth.js'
import { publicUrl } from '../config.js'
import { CONSUMER_TOOLS, OWNER_TOOLS, registerConsumerTools, registerOwnerTools, type ToolContext } from './tools.js'

const mcp = new Hono()

// Smoke test without a token: which tool set each token type gets.
mcp.get('/health', (c) => c.json({ ok: true, tools_owner: [...OWNER_TOOLS], tools_consumer: [...CONSUMER_TOOLS] }))

function unauthorized(c: Context, error: string, message: string) {
  const base = publicUrl(c.req.url)
  c.header('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
  return c.json({ error, message }, 401)
}

function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'data-wallet', version: '0.1.0' },
    {
      instructions:
        ctx.auth.consumerType === 'OWNER'
          ? 'You are connected to the owner’s Data Wallet with owner powers: search every scope, see who read what, revoke agents, import LinkedIn, offer and ship data.'
          : `You are connected to a person’s Data Wallet as "${ctx.auth.consumerName}", read-only, with scopes: ${ctx.auth.scopes.join(', ') || '(none)'}. Requests outside those scopes return no records and are recorded in the owner’s statement.`,
    },
  )
  if (ctx.auth.consumerType === 'OWNER') registerOwnerTools(server, ctx)
  else registerConsumerTools(server, ctx)
  return server
}

mcp.all('/', async (c) => {
  const token = bearer(c)
  if (!token) return unauthorized(c, 'unauthorized', 'Bearer token required')
  const auth = await resolveToken(token)
  if (isFailure(auth)) return unauthorized(c, auth.error, auth.message)
  if (auth.consumerType === 'DATA_IN_AGENT')
    return c.json({ error: 'WRONG_TOKEN_TYPE', message: 'DATA_IN tokens use POST /v1/facts, not /mcp' }, 403)

  const ctx: ToolContext = {
    auth,
    bearerToken: token,
    v1Base: process.env.MCP_V1_BASE?.replace(/\/+$/, '') || new URL(c.req.url).origin,
  }
  const server = buildServer(ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(c.req.raw)
  } finally {
    // Close after the response is produced so no state survives the request.
    void transport.close().catch(() => {})
  }
})

export default mcp
