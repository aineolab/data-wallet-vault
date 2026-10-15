// Every config value comes from env (CLAUDE.md "Self-hosting"). Nothing is tied to our Supabase or Vercel project.
// Parsed once, lazily, so importing this module never throws at build time. Missing values are reported by NAME only.
import { z } from 'zod'

const flag = z.enum(['0', '1']).default('1')

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  // Public origin of the deployed server. Empty until the first deploy; request origin is used as a fallback.
  PUBLIC_URL: z.string().default(''),
  OWNER_PASSPHRASE: z.string().min(8),
  DASHBOARD_ORIGIN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Org-scoped Anthropic keys need header `anthropic-workspace-id` on every Messages API call.
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().optional(),
  MOCK_LINKEDIN: flag,
  MOCK_WEB: flag,
  VAULT_DIR: z.string().default('./vault'),
  PORT: z.coerce.number().int().positive().default(3000),
})

export type Config = z.infer<typeof schema>

let cached: Config | undefined

export function config(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`server config: invalid or missing env: ${names} (see .env.example)`)
  }
  cached = parsed.data
  return cached
}

/** Public origin for OAuth metadata and links: PUBLIC_URL if set, else the origin the request came in on. */
export function publicUrl(requestUrl: string): string {
  const fromEnv = config().PUBLIC_URL.replace(/\/+$/, '')
  return fromEnv || new URL(requestUrl).origin
}
