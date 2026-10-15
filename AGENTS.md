<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Data Wallet rules for any coding agent (Lovable included)
- Read `CLAUDE.md` first. It is the spec.
- **Do not edit** `server/`, `supabase/`, `db/`, `seed/`, `eval/`, `agents/`. The Lovable app owns only `src/`, `public/` and root config.
- The web app may call `server/` `/v1` read endpoints only. Never put a Supabase service key or any secret in client code.
- Never enable Lovable Cloud for this project; the wallet uses its own Supabase project via `server/`.

## Dashboard conventions (from Lovable)
- Keep wallet dashboard UI in src/components/wallet and REST types, fixtures, and queries in src/lib/wallet so presentation stays separate from the external API contract.
- Wallet API calls execute in the browser with a session-only bearer token; no local server or database integration is needed for this external wallet dashboard.
- Wallet tabs use URL search state and initial content uses the router Query cache so direct links and SSR remain consistent.
