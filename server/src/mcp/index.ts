// mcp lane. One endpoint, streamable HTTP, stateless; tools/list filtered by token type (CLAUDE.md "MCP tools").
// Until the lane lands: 401 + RFC 9728 pointer so OAuth clients discover the metadata.
import { Hono } from 'hono'
import { publicUrl } from '../config.js'

const mcp = new Hono()

mcp.all('/', (c) => {
  const base = publicUrl(c.req.url)
  c.header('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
  return c.json({ error: 'unauthorized', message: 'Bearer token required' }, 401)
})

export default mcp
