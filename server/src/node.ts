// Node / Docker entry (self-host). Vercel uses src/index.ts directly.
import { serve } from '@hono/node-server'
import app from './index.js'
import { config } from './config.js'

const { PORT } = config()
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`data-wallet server listening on http://localhost:${info.port}`)
})
