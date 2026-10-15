// Runtime for the Normalizer (feature 6). Every invocation: upload the export, create a session against the
// agent `ant apply` created, smoke-test the wallet, then kick off with an Outcome and stream until done.
//
// Setup lives in files, not here:  ant apply agents/normalizer.md environments/wallet-cloud.yaml
// Required env (server/.env is loaded by `npm run normalizer`):
//   NORMALIZER_AGENT_ID   resources["./agents/normalizer.md"].id in claude-lock.json
//   WALLET_ENV_ID         resources["./environments/wallet-cloud.yaml"].id
//   WALLET_VAULT_ID       vault holding the WALLET_DATA_IN_TOKEN environment_variable credential
//   PUBLIC_URL            the wallet server origin
//   WALLET_RAW_FILE_ID    raw_vault_files.id the facts attach to (from POST /v1/ingest)
// Auth: ANTHROPIC_API_KEY, or an `ant auth login` profile. Org-scoped keys also need ANTHROPIC_WORKSPACE_ID.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'

const here = path.dirname(fileURLToPath(import.meta.url))
const need = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`missing env ${k}`)
  return v
}
const AGENT_ID = need('NORMALIZER_AGENT_ID')
const ENV_ID = need('WALLET_ENV_ID')
const VAULT_ID = need('WALLET_VAULT_ID')
const WALLET_URL = need('PUBLIC_URL').replace(/\/+$/, '')
const RAW_FILE_ID = need('WALLET_RAW_FILE_ID')

const client = new Anthropic({
  defaultHeaders: process.env.ANTHROPIC_WORKSPACE_ID
    ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID }
    : undefined,
})

const STARTER_RUBRIC = `# Normalizer outcome rubric - starter, tune after the first scored run
- Every fact posted to /v1/facts has provenance of the form conv_NNN#N that points at a real user message
- Every fact's category is one of: work_profile, coding_preferences, shopping_preferences, personal_memory, health_finance_restricted
- No fact, report line or summary contains a secret: nothing matching sk-, sk-ant-, sk-proj-, ghp_, xoxb-, AKIA, AIza, eyJ, a 13-19 digit number, or -----BEGIN
- Facts are about Dana only; nobody else is the subject of a fact (Dana's relationships count: "Dana's partner is called Sam")
- Every fact is 5-12 words, one clause, starts with "Dana", and reuses the source's own nouns; no reasons, feelings or dates appended
- Every user message that states a durable preference, role, habit, purchase intent, relationship or constraint produced exactly one fact (two only when it states two distinct things)
- Every health, medication, money, mortgage, salary or insurance fact is categorised health_finance_restricted
- All 30 conversations were read; /mnt/session/outputs/normalizer-report.json lists every skipped message with a reason
- Every POST to /v1/facts returned 2xx, or is listed under post_failures with the status code
`

async function main() {
  // 1. The export is mounted read-only; the agent never sees the repo.
  const file = await client.beta.files.upload({
    file: fs.createReadStream(path.join(here, '..', 'seed', 'out', 'conversations.json')),
  })

  // 2. Session: pointer to the agent, the sandbox, the file, and the vault with the DATA_IN token.
  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENV_ID,
    title: 'Normalizer: seed chat export',
    resources: [{ type: 'file', file_id: file.id, mount_path: '/conversations.json' }],
    vault_ids: [VAULT_ID],
  })
  console.log(`session ${session.id}`)
  console.log(`watch: https://platform.claude.com/workspaces/default/sessions/${session.id}`)

  // 3. Stream first, then send. Smoke-test the wallet before the real kickoff.
  const stream = await client.beta.sessions.events.stream(session.id)
  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: 'user.message',
        content: [
          {
            type: 'text',
            text:
              `WALLET_URL is ${WALLET_URL}. Confirm you can reach it: run \`curl -s $WALLET_URL/health\` and report ` +
              `the "ok" field. Do not start the extraction yet.`,
          },
        ],
      },
    ],
  })

  let kickedOff = false
  loop: for await (const event of stream) {
    switch (event.type) {
      case 'agent.message':
        for (const block of event.content) if (block.type === 'text') process.stdout.write(block.text)
        process.stdout.write('\n')
        break
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
        if (event.evaluated_permission === 'ask') {
          // Unattended run: the only host it can reach is the wallet, so allow.
          await client.beta.sessions.events.send(session.id, {
            events: [{ type: 'user.tool_confirmation', tool_use_id: event.id, result: 'allow' }],
          })
        }
        break
      case 'session.status_idle':
        if (event.stop_reason.type === 'requires_action') break // waiting on us; keep streaming
        if (!kickedOff) {
          kickedOff = true
          await client.beta.sessions.events.send(session.id, {
            events: [
              {
                type: 'user.define_outcome',
                description:
                  `Normalize /mnt/session/uploads/conversations.json into wallet facts and post them to ` +
                  `${WALLET_URL}/v1/facts with raw_file_id "${RAW_FILE_ID}". Write the report to ` +
                  `/mnt/session/outputs/normalizer-report.json.`,
                rubric: { type: 'text', content: STARTER_RUBRIC },
                max_iterations: 3,
              },
            ],
          })
          break
        }
        break loop
      case 'session.status_terminated':
        break loop
      case 'session.error':
        console.error('session error', JSON.stringify(event))
        break loop
    }
  }

  // 4. Pull the report. Outputs index a second or two after idle.
  for (let attempt = 0; attempt < 3; attempt++) {
    const files = await client.beta.files.list({ scope_id: session.id, betas: ['managed-agents-2026-04-01'] })
    const report = files.data.find((f) => f.filename.endsWith('normalizer-report.json'))
    if (report) {
      const body = await (await client.beta.files.download(report.id)).text()
      const out = path.join(here, 'out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'normalizer-report.json'), body)
      console.log(`report -> agents/out/normalizer-report.json`)
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.warn('no report file found in session outputs')
}

main().catch((err) => {
  console.error(err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err)
  process.exit(1)
})
