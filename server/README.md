# server/ — the wallet's front door

Its own Node project (Hono + `@modelcontextprotocol/sdk`), deployed to Vercel with Root Directory = `server`,
or run in Docker for self-hosting. Not part of the Lovable app at the repo root. Spec: `../CLAUDE.md`.

## Layout
```
src/index.ts   the Hono app (default export = Vercel function, zero config)
src/node.ts    Node/Docker entry: @hono/node-server on $PORT (3000)
src/config.ts  env parsing (zod); fails with the NAMES of missing vars, never values
src/db.ts      one pg Pool per process; every token/scope check hits Postgres
```

## Config
All config is env. Copy `../.env.example` to `server/.env` for local runs; add the same values in Vercel →
Settings → Environment Variables. Never commit real values.

## Three ways to run
1. **Local:** `npm install && npm run dev` (reads `server/.env`, serves http://localhost:3000). `npm test` for the unit tests.
2. **Vercel:** `cd server && vercel` (first run links the project; Root Directory = `server`). Set the env vars,
   then set `PUBLIC_URL` to the deployment URL and redeploy. Functions run in `lhr1` (see `vercel.json`).
3. **Docker / self-host:** from the repo root, `docker compose up` starts Postgres + pgvector (schema from `../db/*.sql`)
   and this server on :3000. The image is built from `server/Dockerfile`.

`GET /health` reports DB reachability, table count and applied migrations.
