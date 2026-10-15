// /v1 mount point. Each lane owns ONE file here and never edits this index or another lane's file:
//   wallet.ts   wallet-api lane: tokens, memories/query, profile, ledger, connections, ship
//   linkedin.ts linkedin lane:   jobs, jobs/tick, sources/linkedin/*
//   exposure.ts exposure lane:   exposure*, privacy-requests*
//   facts.ts    normalizer lane: facts
// Core changes go through server/INTEGRATION.md and the integrator.
import { Hono } from 'hono'
import wallet from './wallet.js'
import linkedin from './linkedin.js'
import exposure from './exposure.js'
import facts from './facts.js'

const v1 = new Hono()
v1.route('/', wallet)
v1.route('/', linkedin)
v1.route('/', exposure)
v1.route('/', facts)

export default v1
