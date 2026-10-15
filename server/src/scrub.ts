// Scrubber (feature 6, Lane B). A pure function: no I/O, no model. Non-negotiable 3: zero planted secrets reach
// canonical_memories, so /v1/facts calls containsSecret() on every fact and drops the ones that match.
// Benign identifiers (git SHAs, container ids, UUIDs, usernames, handles, emails, employer names) must survive:
// the patterns below are prefix- or structure-anchored, never "any long hex string".

export type SecretKind =
  | 'anthropic_key'
  | 'openai_key'
  | 'generic_sk_key'
  | 'github_pat'
  | 'slack_token'
  | 'aws_key'
  | 'google_api_key'
  | 'jwt'
  | 'card_number'
  | 'iban'
  | 'private_key'
  | 'password'

export interface ScrubHit {
  kind: SecretKind
  /** The replacement that went into `clean`, e.g. "[REDACTED:aws_key]". Never the secret itself. */
  redacted: string
}

export interface ScrubResult {
  clean: string
  hits: ScrubHit[]
}

interface Rule {
  kind: SecretKind
  re: RegExp
  /** Extra check on the match; return false to keep the text. */
  accept?: (m: RegExpExecArray) => boolean
}

// Order matters: specific prefixes before the generic `sk-` rule, and the private-key block before anything
// that could match inside it.
const RULES: Rule[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai_key', re: /\bsk-proj-[A-Za-z0-9_-]{16,}/g },
  { kind: 'generic_sk_key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'github_pat', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'slack_token', re: /\bxox[bpas]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Three base64url segments; the header segment of a real JWT always starts with eyJ ('{"').
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // IBAN: country code, 2 check digits, 11-30 alphanumerics, optional spaces between groups.
  {
    kind: 'iban',
    re: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,4})?\b/g,
    accept: (m) => {
      const s = m[0].replace(/[ -]/g, '')
      return s.length >= 15 && s.length <= 34 && ibanChecksumOk(s)
    },
  },
  // Card numbers: 13-19 digits, optional space/dash separators, must pass Luhn. Plain digit runs that fail Luhn
  // (order numbers, phone numbers, timestamps) are left alone.
  {
    kind: 'card_number',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => {
      const digits = m[0].replace(/[ -]/g, '')
      return digits.length >= 13 && digits.length <= 19 && luhnOk(digits)
    },
  },
  // "password: hunter2", "passphrase = correct horse", "PIN is 4921", "OTP 123456". Value runs to end of token/line.
  {
    kind: 'password',
    re: /\b(?:password|passwd|passphrase|pin(?:\s*code)?|otp|one[- ]time (?:code|password)|recovery code)\b\s*(?:is|was|=|:|->)?\s*["'`]?([^\s"'`,;]{3,})/gi,
    accept: (m) => {
      const v = (m[1] ?? '').replace(/[.!?)\]]+$/, '')
      // "password manager", "password reset", "pin it", "PIN pad": a following ordinary word is not a value.
      return !/^(manager|reset|field|prompt|policy|change|changed|strength|hash|hashing|less|protected|for|it|this|that|the|a|an|and|or|to|of|in|on|is|was|be)$/i.test(v)
    },
  },
]

function luhnOk(digits: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

function ibanChecksumOk(iban: string): boolean {
  // Move the first 4 chars to the end, map letters to numbers, mod 97 must be 1.
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0)
    const piece = code >= 65 && code <= 90 ? String(code - 55) : code >= 48 && code <= 57 ? ch : null
    if (piece === null) return false
    for (const p of piece) remainder = (remainder * 10 + (p.charCodeAt(0) - 48)) % 97
  }
  return remainder === 1
}

/** Replace every secret in `text` with `[REDACTED:<kind>]`. Pure. */
export function scrub(text: string): ScrubResult {
  const hits: ScrubHit[] = []
  let clean = text ?? ''
  for (const rule of RULES) {
    clean = clean.replace(rule.re, (...args) => {
      const m = args as unknown as RegExpExecArray
      if (rule.accept && !rule.accept(m)) return m[0]
      const redacted = `[REDACTED:${rule.kind}]`
      hits.push({ kind: rule.kind, redacted })
      return redacted
    })
  }
  return { clean, hits }
}

/** True when `text` holds at least one secret. */
export function containsSecret(text: string): boolean {
  return scrub(text).hits.length > 0
}
