// Mock web (MOCK_WEB=1): search + fetch answered from seed/out/exposure/web_index.json.
// 8 fictional .example pages: 5 real hits, 1 namesake dentist in Bristol, 1 employer-only news page, 1 robots-blocked site.
// The robots flag is enforced HERE: a blocked page is never "fetched" (its text never leaves this module), only listed
// by the search as a URL the scan then reports as "couldn't check".
//
// Vercel (Root Directory = server) has no seed/ and the repo is private, so the index is also shipped as a static file at
// server/public/seed/exposure/web_index.json and resolved via env MOCK_WEB_SEED_URL first, then local paths.
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

export const isMockWeb = () => config().MOCK_WEB === '1'

export type SiteType =
  | 'people_search'
  | 'data_broker'
  | 'social_profile'
  | 'forum'
  | 'news'
  | 'breach_notice'
  | 'search_engine'
  | 'company_site'
  | 'other'

/** A search result: enough to list the page, never its content. */
export interface SearchHit {
  url: string
  site: string
  site_type: SiteType
}

/** A fetched public page. `allowed = false` means robots.txt disallows it and `text` is absent. */
export type FetchedPage =
  | { url: string; allowed: true; site: string; site_type: SiteType; text: string; privacy_contact: string | null; opt_out_form: string | null }
  | { url: string; allowed: false; reason: string }

/** Any web source (mock today; Tavily/Exa later) implements exactly this. The scan never touches anything else. */
export interface WebSource {
  name: string
  search(query: string): Promise<SearchHit[]>
  fetch(url: string): Promise<FetchedPage>
}

interface IndexPage {
  url: string
  site: string
  site_type: SiteType
  robots_allowed: boolean
  text: string
  privacy_contact: string | null
  opt_out_form: string | null
}

const INDEX_NAME = 'web_index.json'
const SEED_DIR = 'seed/out/exposure'

function localCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    process.env.MOCK_WEB_SEED_DIR ? resolve(process.env.MOCK_WEB_SEED_DIR, INDEX_NAME) : '',
    resolve(process.cwd(), SEED_DIR, INDEX_NAME), // cwd = repo root
    resolve(process.cwd(), '..', SEED_DIR, INDEX_NAME), // cwd = server/
    resolve(here, '../../..', SEED_DIR, INDEX_NAME), // from server/src/exposure or server/dist/exposure
    resolve(here, '../../public/seed/exposure', INDEX_NAME), // the static copy shipped with the server
    resolve(process.cwd(), 'public/seed/exposure', INDEX_NAME),
  ].filter(Boolean)
}

let cached: IndexPage[] | undefined

async function loadIndex(): Promise<IndexPage[]> {
  if (cached) return cached
  let raw: string | undefined
  const base = process.env.MOCK_WEB_SEED_URL?.replace(/\/+$/, '')
  if (base) {
    const res = await fetch(`${base}/${INDEX_NAME}`)
    if (res.ok) raw = await res.text()
  }
  if (raw === undefined) {
    for (const p of localCandidates()) {
      if (existsSync(p)) {
        raw = await readFile(p, 'utf8')
        break
      }
    }
  }
  if (raw === undefined) throw new Error(`mock web: ${INDEX_NAME} not found locally${base ? ` or at ${base}` : ''} (set MOCK_WEB_SEED_URL)`)
  const parsed = JSON.parse(raw) as { pages: IndexPage[] }
  cached = parsed.pages
  return cached
}

/** Terms a query asks for: quoted phrases, else whitespace tokens. */
function queryTerms(query: string): string[] {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim()).filter(Boolean)
  if (quoted.length) return quoted
  return query.split(/\s+/).filter(Boolean)
}

/**
 * The mock search engine: a page is a hit when its text or URL contains the query's first (primary) term, like a real
 * engine indexing a page's content. Robots-blocked pages ARE listed (engines show the URL) but are never readable.
 */
export const mockWeb: WebSource = {
  name: 'mock_web',
  async search(query) {
    const pages = await loadIndex()
    const terms = queryTerms(query).map((t) => t.toLowerCase())
    const primary = terms[0]
    if (!primary) return []
    return pages
      .filter((p) => p.text.toLowerCase().includes(primary) || p.url.toLowerCase().includes(primary.replace(/\s+/g, '-')))
      .map((p) => ({ url: p.url, site: p.site, site_type: p.site_type }))
  },
  async fetch(url) {
    const pages = await loadIndex()
    const p = pages.find((x) => x.url === url)
    if (!p) return { url, allowed: false, reason: 'page not found (404)' }
    if (!p.robots_allowed) return { url, allowed: false, reason: "robots.txt disallows fetching this page; couldn't check" }
    return { url, allowed: true, site: p.site, site_type: p.site_type, text: p.text, privacy_contact: p.privacy_contact, opt_out_form: p.opt_out_form }
  },
}

/** The web source for this process. Only the mock exists today; Tavily/Exa are roadmap (see INTEGRATION.md). */
export function webSource(): WebSource {
  if (isMockWeb()) return mockWeb
  throw Object.assign(new Error('Live web search is not configured (set MOCK_WEB=1, or add a Tavily/Exa source)'), {
    code: 'WEB_SEARCH_NOT_CONFIGURED',
  })
}

/**
 * The synthetic owner's verified identifiers (CLAUDE.md non-negotiable 8: the only user is Dana Whitfield). Seeded into
 * owner_identifiers on the first scan when the table is empty and MOCK_WEB=1, so the demo and eval run hands-free.
 * Mirrors seed/out/exposure/exposure_key.json "owner_identifiers".
 */
export const DEMO_OWNER_IDENTIFIERS: { kind: string; value: string }[] = [
  { kind: 'full_name', value: 'Dana Whitfield' },
  { kind: 'email', value: 'dana.whitfield@mail.example' },
  { kind: 'city', value: 'Leeds' },
  { kind: 'employer', value: 'Parcelgrid' },
  { kind: 'username', value: 'dwhitfield_dev' },
]
