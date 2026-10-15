# Data Wallet — pitch deck (Accel AI Innovate: London, 15 Oct 2026)

Slides are also published as a Claude Slides artifact; this file is the same content in text form so judges can read it without an account.
Live: https://data-wallet-vault.lovable.app · Server: https://data-wallet-server-nyolab.vercel.app · Repo: https://github.com/aineolab/data-wallet-vault

## 1. Your data, inside your agents, on your terms
A wallet for a person's data that any AI agent can read — only the scopes you granted, with every read on a ledger you can revoke. Open source, self-hostable. Tim Santos, solo build, with Claude Code agents working as a team.

## 2. The problem: your agents already hold your life; you hold none of the controls
- No visibility: each chat app keeps its own memory of you; you can't list what it knows or which answers used it.
- No scoping: the agent that picks your TypeScript framework can also read your health and mortgage notes.
- No portability: switch AI vendors and you start from zero.

## 3. The product: a wallet, not a database
1. Deposit — exports go in (LinkedIn archive, chat history, images). Secrets are scrubbed; every fact keeps its provenance.
2. Grant — agents get scopes (work, coding, shopping, memories). Health and finance stay locked unless you say so.
3. Ledger — every read is written: who asked, what was served, what was blocked. Append-only, in the database.
4. Revoke / ship — revoke an agent in one call; ship data to a buyer exclusively, after which the wallet refuses resale.
Scope is enforced in SQL, never by a model: `scope_category = ANY(granted) AND is_quarantined = FALSE`.

## 4. Agent-native: every owner action is an MCP tool; the web app is second
- Claude, ChatGPT, Claude Code connect to one endpoint; the tool list depends on who holds the token.
- Owner tools: wallet_deposit · wallet_search · wallet_connections · wallet_revoke · wallet_statement · wallet_ship · wallet_request_linkedin_export · wallet_linkedin_drift
- Consumer tools (read-only): wallet_get_identity_card · wallet_search_memories
- Hono + MCP SDK on Vercel today, `docker compose up` for self-host; Postgres + pgvector; config is env only. Token checks hit the DB on every call, so revoke takes effect on the next request.

## 5. Live demo: five beats, two agents, one wallet (synthetic user "Dana Whitfield", seeded export, mock LinkedIn)
| # | Who | Says | The wallet shows |
|---|---|---|---|
| 1 | Claude (owner) | "Get my LinkedIn data into my wallet." | Job created; 3 roles, 8 skills, 120 connections counted, none stored by name |
| 2 | Second agent (coding scope only) | "What stack should I use?" | Answered from the wallet; the read is on the ledger |
| 3 | Same agent | "What's my mortgage situation?" | Empty result + SCOPE_RESTRICTED; a SCOPE_BLOCKED ledger row |
| 4 | Claude (owner) | "Who read my wallet today? Revoke the second agent." | Statement; the agent's next call fails with WALLET_ACCESS_REVOKED |
| 5 | Claude (owner) | "Ship my shopping data to Acme, exclusive." | Signed hand-off, copy destroyed; a second buyer gets RESALE_BLOCKED |

## 6. How it was built today: agents built it, ran it, other models graded it
- A team of Claude Code agents: one spec (CLAUDE.md), one integrator, parallel lanes in git worktrees (wallet API, MCP, LinkedIn), each owning one folder and one test; merged on green.
- A long-running hosted agent: the Normalizer runs as a Managed Agent — reads chat exports, scrubs secrets, posts facts with provenance; scored first, then hill-climbed.
- Graded by other models: fact precision and red-team injections judged by GLM, DeepSeek and GPT-6 Astra via the NYO router (Vercel AI Gateway backend). No self-grading.
- Anthropic's five-step loop: `claude auth login --console` → `/claude-api managed-agents-onboard` → `/goal` → `/claude-api build-eval` → `/claude-api hillclimb`.
- Results (own evals, synthetic data): red-team PASS (0 restricted leaks, 43 blocked reads ledgered); linkedin_drift 10/10; 0 planted secrets reached the wallet. See eval/RESULTS.md.

## 7. What's next: the wallet is the primitive; every data source is a plug-in
- In the repo, not on stage: LinkedIn drift check against the live API; Exposure Finder (where your data appears online, with GDPR access/erasure drafts); images and audio as facts.
- Next month: real owner auth and multi-tenant; buyer webhooks for exclusive shipping; a data-sourcer agent that drafts export requests.
- The ask: connect the wallet to your Claude, deposit one export, and tell me what the ledger should have refused. Apache-2.0.
