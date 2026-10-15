# agents/ — hosted agents (Anthropic Managed Agents)

The wallet's long-running jobs are Managed Agents, not code in the server. Today there is one: the **Normalizer**
(feature 6), which turns a chat-history export into facts and posts them to the wallet's `POST /v1/facts`.
It calls the wallet over HTTPS with its own `DATA_IN` token and never touches the database. Spec: `../CLAUDE.md`.

## How the Normalizer is defined

Two files describe it; `ant apply` makes them real and records the resulting IDs.

| File | What it is |
|---|---|
| `agents/normalizer.md` | The agent: YAML front matter (name, `model: claude-opus-5-5`, toolset with `web_fetch` and `web_search` disabled) followed by the system prompt. The prompt holds the Scrubber rules (what counts as a secret and is never emitted), the fact rules (one sentence, third person, one category, `provenance` of the form `conv_012#4`, no provenance no fact), the batching rules for `POST /v1/facts`, and the report format. |
| `environments/wallet-cloud.yaml` | The sandbox: `type: cloud`, networking `limited`, package managers off, `allowed_hosts` is the wallet server only. The agent can reach nothing else. |
| `claude-lock.json` | Written by `ant apply`: the agent id, environment id, versions and hashes, under the org and workspace it was applied to. Commit it; the runtime reads the ids from env, which you copy from here. |

Apply (or re-apply after editing the prompt):

```bash
ant apply agents/normalizer.md environments/wallet-cloud.yaml
```

The lock file then shows, for example, `resources["./agents/normalizer.md"].id = agent_015DExDComxJS4VjFKqZbgWf`.

## Vault and credentials, in two sentences

The agent needs a wallet token but must never see it in its prompt or the repo, so the `WALLET_DATA_IN_TOKEN` lives in a
Managed Agents **vault** as an `environment_variable` credential, and each session is created with that `vault_id`; inside
the sandbox the agent sees a placeholder, sends it verbatim as `Authorization: Bearer $WALLET_DATA_IN_TOKEN`, and the
platform substitutes the real value on the way out. The wallet server checks that token against Postgres on every call,
so revoking the `DATA_IN` grant cuts the agent off at once, and `/v1/facts` only accepts rows that carry provenance.

## How it runs

```bash
cd agents && npm install && npm run normalizer
```

`npm run normalizer` is `tsx --env-file=../server/.env run-normalizer.ts`. It needs these in `server/.env`:

| Env | From |
|---|---|
| `NORMALIZER_AGENT_ID` | `claude-lock.json` → `resources["./agents/normalizer.md"].id` |
| `WALLET_ENV_ID` | `claude-lock.json` → `resources["./environments/wallet-cloud.yaml"].id` |
| `WALLET_VAULT_ID` | the vault holding `WALLET_DATA_IN_TOKEN` |
| `PUBLIC_URL` | the wallet server origin, e.g. `https://data-wallet-server.vercel.app` |
| `WALLET_RAW_FILE_ID` | `raw_vault_files.id` the facts attach to, from `POST /v1/ingest` |
| `ANTHROPIC_API_KEY` (+ `ANTHROPIC_WORKSPACE_ID` for org-scoped keys) | your Anthropic account, or an `ant auth login` profile |

Each run: uploads `seed/out/conversations.json` as a session file, creates a session against the applied agent in the
`wallet-cloud` environment with the vault attached, kicks off with an outcome rubric (provenance on every fact, five
categories only, no secrets, Dana only, every POST 2xx or reported), and streams until done. The agent writes
`/mnt/session/outputs/normalizer-report.json` with counts, scrubbed-message refs (refs only) and post failures.

## Measuring it

```bash
python3 eval/score.py     # recall, precision, secret leaks against seed/out/answer_key.json
```

Record the first score in `eval/RESULTS.md` before tuning the prompt, then hill-climb for at most 45 minutes.
Independent fact-precision audits run on NYO models through `eval/judge.py` so the work never grades itself.
Delete the temporary `seed_fixture` rows before measuring (see `server/INTEGRATION.md`), otherwise precision is graded
against the answer key itself.

Status on 15 Oct 2026: the Normalizer lane is still running its first scored pass; see `eval/RESULTS.md` once it lands.
