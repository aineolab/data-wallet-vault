// wallet-api lane. Routes (CLAUDE.md "Internal REST"): POST /tokens/issue, POST /memories/query, GET /profile,
// DELETE /tokens/:id, POST /ship, GET /ledger, GET /connections. Uses core: auth.ts, scopes.ts, ledger.ts.
import { Hono } from 'hono'

const wallet = new Hono()

export default wallet
