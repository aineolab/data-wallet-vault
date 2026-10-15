# Hero run — kickoff for Claude Code

Paste everything below the line into Claude Code as your first message, then run the `/goal` at the bottom.

---

You are building the Data Wallet hackathon demo. Read `CLAUDE.md` first; it is the spec and it wins over anything else.
Pitch is at 16:00. **Hard stop for new features: 14:30.**

## Setup (do first, ask me only for secrets)
1. Check `server/.env` exists with DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY and OWNER_PASSPHRASE filled. If any are empty,
   stop and tell me exactly which one and where to find it (see `.env.example`). Never print secret values.
2. The database is already migrated (14 tables + hardening, project `fqnqhzstqtexarnlgusv` in the bzworkai org, London). Do not run destructive SQL.
3. Create `server/` as its own Node 20 project: Hono, `@modelcontextprotocol/sdk` (streamable HTTP, stateless), `pg`,
   `@supabase/supabase-js`, `zod`, `vitest`. Add `server/vercel.json` and `server/Dockerfile`.
4. Deploy with `vercel` from `server/` (Root Directory = server). Set the env vars from `server/.env` in Vercel.
   Set PUBLIC_URL to the deployment URL and redeploy. **Tell me the URL as soon as it exists.**

## Phase 1 — must pass first (features 1, 2, 3, 4)
- MCP at `/mcp`, bearer auth, tools filtered by token type (owner vs consumer), scope enforced in SQL,
  `health_finance_restricted` never served by default, append-only ledger rows for every read/block/revoke.
- REST `/v1/*` exactly as in CLAUDE.md, including the dashboard endpoints and CORS for DASHBOARD_ORIGIN.
- Seed: load `seed/out/answer_key.json` facts directly as canonical memories ONLY as a temporary fixture so the
  demo has data before the Normalizer runs; mark them `source_provider='seed_fixture'` and replace them when feature 6 lands.
- LinkedIn mock import (MOCK_LINKEDIN=1): job state machine, `/v1/jobs/tick`, parser shared with the DMA API shape,
  connections as count only, messages skipped.
- Green when: `python3 eval/redteam.py` and `python3 eval/linkedin_flow.py` pass against the Vercel URL.
- Then print the exact `claude mcp add --transport http …` commands for an OWNER token and a
  coding_preferences-only consumer token.

## Phase 2 — parallel subagents, only after phase 1 is green
- **Feature 6:** chat-history Normalizer + Scrubber as a hosted agent (`/claude-api managed-agents-onboard`).
  Run `python3 eval/score.py` once and write the FIRST score to eval/RESULTS.md, then hill-climb the prompt
  (`/claude-api hillclimb`) for at most 30 minutes. If NYO_* is set, run `python3 eval/judge.py facts` for an
  independent check and report which model produced it.
- **Feature 13:** Exposure Finder on the mock web (MOCK_WEB=1). Owner-only, verified identifiers only, robots.txt
  respected, drafts never sent. Green when `python3 eval/exposure_flow.py` passes.

## Rules
- Work on branch `scaffold`. Commit small, push often. Never force-push. Never touch the Lovable app (`src/`, `public/`).
- Never edit `seed/out/*` or `eval/*.py` to make a test pass.
- At 14:30 stop adding features. Report: what passes, what doesn't, the URL, the before/after score.

---

```
/goal Follow HERO_RUN.md: phase 1 (features 1-4) green on the Vercel URL — eval/redteam.py and eval/linkedin_flow.py pass — then phase 2 in parallel subagents: feature 6 (first score recorded, hill-climb ≤30 min, eval/score.py) and feature 13 (eval/exposure_flow.py). Tell me the Vercel URL as soon as it exists. Hard stop 14:30.
```
