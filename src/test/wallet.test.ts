import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWallet, makeDemoData, validateWalletUrl, walletRequest } from '@/lib/wallet/data';

afterEach(() => vi.unstubAllGlobals());
describe('Wallet demo and REST contract', () => {
  it('includes the requested fictional records', () => {
    const data = makeDemoData();
    expect(data.entries).toHaveLength(8);
    expect(data.entries.some(e => e.operation === 'Blocked: out of scope' && e.records_returned === 0)).toBe(true);
    expect(data.connections.map(c => c.consumer_name)).toEqual(['Claude', 'ChatGPT', 'Acme Data']);
    expect(data.jobs[1]?.summary?.connections).toBe(120);
    expect(data.exposures).toHaveLength(5);
  });
  it('reads all five endpoints with bearer authorization', async () => {
    const demo = makeDemoData();
    const bodies: Record<string, unknown> = { '/v1/ledger': { entries: demo.entries }, '/v1/connections': { connections: demo.connections }, '/v1/jobs': { jobs: demo.jobs }, '/v1/exposure': { exposures: demo.exposures }, '/v1/privacy-requests': { requests: demo.requests } };
    const mock = vi.fn(async (url: string, options: RequestInit) => {
      expect(options.headers).toEqual({ Authorization: 'Bearer synthetic-test-token', Accept: 'application/json' });
      return new Response(JSON.stringify(bodies[new URL(url).pathname]), { status: 200 });
    });
    vi.stubGlobal('fetch', mock);
    const data = await fetchWallet('https://wallet.example', 'synthetic-test-token');
    expect(data.live).toBe(true); expect(mock).toHaveBeenCalledTimes(5); expect(data.entries).toHaveLength(8);
  });
  it('does not show fixtures on failed or missing authorization', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const data = await fetchWallet('https://wallet.example', 'invalid-test-token');
    expect(data.live).toBe(false); expect(data.entries).toEqual([]); expect(data.error).toContain('not accepted');
    expect((await fetchWallet('https://wallet.example', '')).connections).toEqual([]);
  });
  it('revokes through DELETE and supports empty responses', async () => {
    const mock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mock);
    await walletRequest('https://wallet.example', 'synthetic-test-token', '/v1/tokens/123', 'DELETE');
    expect(mock.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
  it('rejects insecure external URLs', () => {
    expect(() => validateWalletUrl('http://wallet.example')).toThrow('HTTPS');
    expect(() => validateWalletUrl('https://user:pass@wallet.example')).toThrow('credentials');
    expect(validateWalletUrl('http://localhost:3000/')).toBe('http://localhost:3000');
  });
});
