// linkedin lane. Routes: POST /sources/linkedin/request, POST /jobs/tick, GET /jobs, GET /jobs/:id,
// POST /ingest (with job_id), POST /sources/linkedin/drift, DELETE /grants/:id (revoke DATA_IN grant).
// Logic lives in src/linkedin/ (mock provider, parser, state machine).
import { Hono } from 'hono'

const linkedin = new Hono()

export default linkedin
