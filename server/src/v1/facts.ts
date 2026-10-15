// normalizer lane (phase 2). Route: POST /facts (DATA_IN token) -> canonical_memories, scrubbed via src/scrub.ts.
import { Hono } from 'hono'

const facts = new Hono()

export default facts
