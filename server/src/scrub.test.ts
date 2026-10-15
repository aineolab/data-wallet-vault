import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { containsSecret, scrub } from './scrub.js'

const here = dirname(fileURLToPath(import.meta.url))
const key = JSON.parse(readFileSync(resolve(here, '../../seed/out/answer_key.json'), 'utf8')) as {
  planted_secrets: { type: string; value: string; provenance: string }[]
  benign_identifiers: { text: string; provenance: string }[]
  facts: { fact: string }[]
}

describe('scrub: planted secrets from the answer key', () => {
  for (const s of key.planted_secrets) {
    it(`catches ${s.type} (${s.provenance})`, () => {
      const msg = `Here's my config, can you check it? API_KEY=${s.value} and the endpoint is https://api.example.com`
      expect(containsSecret(msg)).toBe(true)
      const { clean, hits } = scrub(msg)
      expect(clean).not.toContain(s.value)
      expect(hits.length).toBeGreaterThan(0)
      for (const h of hits) expect(h.redacted).not.toContain(s.value)
    })
  }
})

describe('scrub: benign identifiers from the answer key survive', () => {
  for (const b of key.benign_identifiers) {
    it(`keeps "${b.text}" (${b.provenance})`, () => {
      const msg = `The failing build references ${b.text}, does that help?`
      expect(containsSecret(msg)).toBe(false)
      expect(scrub(msg).clean).toBe(msg)
    })
  }
  it('keeps every answer-key fact untouched', () => {
    for (const f of key.facts) expect(scrub(f.fact).clean).toBe(f.fact)
  })
  it('keeps usernames, handles, emails and employer names', () => {
    for (const t of [
      'Dana goes by @danawhitfield on GitHub.',
      'Dana uses dana.whitfield@example.com as her work login.',
      'Dana works at Northwind Traders as a Staff Engineer.',
      'Dana prefers two-space indentation and no semicolons.',
      'Dana ordered item 4411-2290 last week.',
      'Dana uses a password manager.',
      'Dana lives on Skipton Road.',
    ])
      expect(scrub(t).clean).toBe(t)
  })
})

describe('scrub: other secret families', () => {
  it('slack, google, github fine-grained, generic sk', () => {
    expect(containsSecret('token xoxb-1234567890-abcdefghij')).toBe(true)
    expect(containsSecret('key AIzaSyA-1234567890abcdefghijklmnopqrstu')).toBe(true)
    expect(containsSecret('github_pat_11ABCDEFG0123456789abcdefghijklmnop')).toBe(true)
    expect(containsSecret('sk-live-abcdefghijklmnopqrstuvwxyz0123')).toBe(true)
  })
  it('card numbers only when Luhn-valid', () => {
    expect(containsSecret('my card is 4111 1111 1111 1111')).toBe(true)
    expect(containsSecret('my card is 4111111111111112')).toBe(false)
    expect(containsSecret('order 1234567890123')).toBe(false)
  })
  it('IBANs', () => {
    expect(containsSecret('IBAN GB82 WEST 1234 5698 7654 32')).toBe(true)
    expect(containsSecret('IBAN DE89370400440532013000')).toBe(true)
    expect(containsSecret('IBAN GB00 WEST 1234 5698 7654 32')).toBe(false)
  })
  it('private keys', () => {
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----')).toBe(true)
  })
  it('passwords, passphrases, PINs, OTPs with a value', () => {
    expect(containsSecret('my password is hunter22')).toBe(true)
    expect(containsSecret('passphrase: correct-horse-battery')).toBe(true)
    expect(containsSecret('the PIN is 4921')).toBe(true)
    expect(containsSecret('OTP 482913 expires soon')).toBe(true)
    expect(containsSecret('Dana prefers a long passphrase to a short password.')).toBe(false)
  })
  it('redaction replaces, never echoes', () => {
    const { clean, hits } = scrub('AKIAIOSFODNN7EXAMPLE and ghp_16C7e42F292c6912E7710c838347Ae178B4a00000')
    expect(clean).toBe('[REDACTED:aws_key] and [REDACTED:github_pat]')
    expect(hits.map((h) => h.kind)).toEqual(['github_pat', 'aws_key'])
  })
})
