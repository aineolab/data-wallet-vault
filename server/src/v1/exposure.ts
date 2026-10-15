// exposure lane (phase 2). Routes: POST /exposure/scan, GET /exposure, privacy-requests*. Logic in src/exposure/.
import { Hono } from 'hono'

const exposure = new Hono()

export default exposure
