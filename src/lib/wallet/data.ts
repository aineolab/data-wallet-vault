export type LedgerEntry = { created_at: string; consumer_name: string; operation: string; scopes_requested: string[]; scopes_served: string[]; records_returned: number };
export type Connection = { token_id: string; consumer_name: string; consumer_type: string; allowed_scopes: string[]; expires_at: string | null; is_revoked: boolean; exclusive: boolean; status?: string };
export type Job = { id: string; provider: string; state: string; created_at: string; updated_at: string; summary?: { roles?: number; skills?: number; connections?: number; connections_counted?: number } };
export type Exposure = { id: string; site?: string; site_name?: string; type?: string; exposure_type?: string; data_shown?: string[]; data_types?: string[]; risk?: string; risk_level?: string; confidence?: string | number; is_namesake?: boolean; recommended_action?: string };
export type PrivacyRequest = { id: string; exposure_id?: string; site?: string; site_name?: string; status: string; due_at?: string; due_date?: string; request_type?: string };
export type WalletData = { entries: LedgerEntry[]; connections: Connection[]; jobs: Job[]; exposures: Exposure[]; requests: PrivacyRequest[]; live: boolean; error?: string };
export const emptyWallet: WalletData = { entries: [], connections: [], jobs: [], exposures: [], requests: [], live: false };
export const configuredUrl = (import.meta.env['VITE_WALLET_URL'] ?? '').trim().replace(/\/+$/, '');
export const scopeNames: Record<string, string> = { work_profile: 'Work profile', coding_preferences: 'Coding preferences', shopping_preferences: 'Shopping preferences', personal_memory: 'Personal memory', health_finance_restricted: 'Health & money (never shared by default)' };
export function makeDemoData(): WalletData {
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const future = (days: number) => new Date(now + days * 86400000).toISOString();
  return {
    live: false,
    entries: [
      { created_at: ago(1), consumer_name: 'Claude', operation: 'Searched memories', scopes_requested: ['coding_preferences'], scopes_served: ['coding_preferences'], records_returned: 4 },
      { created_at: ago(3), consumer_name: 'ChatGPT', operation: 'Blocked: out of scope', scopes_requested: ['health_finance_restricted'], scopes_served: [], records_returned: 0 },
      { created_at: ago(6), consumer_name: 'Claude', operation: 'Read identity card', scopes_requested: ['work_profile'], scopes_served: ['work_profile'], records_returned: 1 },
      { created_at: ago(12), consumer_name: 'Acme Data (buyer)', operation: 'Data shipped', scopes_requested: ['shopping_preferences'], scopes_served: ['shopping_preferences'], records_returned: 12 },
      { created_at: ago(18), consumer_name: 'Acme Data (buyer)', operation: 'Resale blocked', scopes_requested: ['shopping_preferences'], scopes_served: [], records_returned: 0 },
      { created_at: ago(26), consumer_name: 'ChatGPT', operation: 'Searched memories', scopes_requested: ['coding_preferences'], scopes_served: ['coding_preferences'], records_returned: 3 },
      { created_at: ago(42), consumer_name: 'Claude', operation: 'LinkedIn drift check', scopes_requested: ['work_profile'], scopes_served: ['work_profile'], records_returned: 3 },
      { created_at: ago(65), consumer_name: 'Former AI assistant', operation: 'Access revoked', scopes_requested: ['personal_memory'], scopes_served: [], records_returned: 0 },
    ],
    connections: [
      { token_id: 'demo-claude', consumer_name: 'Claude', consumer_type: 'ai_agent', allowed_scopes: ['work_profile', 'coding_preferences'], expires_at: future(30), is_revoked: false, exclusive: false },
      { token_id: 'demo-chatgpt', consumer_name: 'ChatGPT', consumer_type: 'ai_agent', allowed_scopes: ['coding_preferences'], expires_at: future(14), is_revoked: false, exclusive: false },
      { token_id: 'demo-acme', consumer_name: 'Acme Data', consumer_type: 'data_buyer', allowed_scopes: ['shopping_preferences'], expires_at: future(7), is_revoked: false, exclusive: true, status: 'shipped' },
    ],
    jobs: [
      { id: 'linkedin-current', provider: 'LinkedIn', state: 'importing', created_at: ago(38), updated_at: ago(1) },
      { id: 'linkedin-complete', provider: 'LinkedIn', state: 'done', created_at: ago(1440), updated_at: ago(1380), summary: { roles: 3, skills: 8, connections: 120 } },
    ],
    exposures: [
      { id: 'findpeople', site: 'FindPeopleNow', type: 'people-search', data_shown: ['Name', 'Address', 'Phone'], risk: 'high', confidence: 'Confirmed match', recommended_action: 'Request erasure' },
      { id: 'dataharbor', site: 'DataHarbor Marketing', type: 'data broker', data_shown: ['Email', 'Shopping interests'], risk: 'high', confidence: 'Strong match', recommended_action: 'Request access' },
      { id: 'nodecraft', site: 'Nodecraft Forum', type: 'forum', data_shown: ['Username', 'Posts'], risk: 'medium', confidence: 'Confirmed match', recommended_action: 'Remove old profile' },
      { id: 'breachwatch', site: 'BreachWatch', type: 'breach', data_shown: ['Email', 'Password hash'], risk: 'high', confidence: 'Confirmed match', recommended_action: 'Monitor' },
      { id: 'bristol', site: 'Bristol Smiles Dental', type: 'company site', data_shown: ['Name'], risk: 'low', confidence: 'probably not you', is_namesake: true, recommended_action: 'No action' },
    ],
    requests: [
      { id: 'req-1', exposure_id: 'findpeople', status: 'Sent', due_at: future(30), request_type: 'Erasure' },
      { id: 'req-2', exposure_id: 'dataharbor', status: 'Acknowledged', due_at: future(21), request_type: 'Access' },
      { id: 'req-3', exposure_id: 'nodecraft', status: 'Drafted', request_type: 'Erasure' },
    ],
  };
}
export function validateWalletUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) throw new Error('Use an HTTPS wallet server URL.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use a wallet server URL without credentials, query, or fragment.');
  return url.trim().replace(/\/+$/, '');
}
export async function walletRequest<T>(url: string, token: string, path: string, method = 'GET'): Promise<T> {
  const base = validateWalletUrl(url);
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Owner token was not accepted. Check your token in Settings.' : `Wallet request failed (${response.status}).`);
  if (response.status === 204 || method === 'DELETE') return undefined as T;
  return response.json();
}
export async function fetchWallet(url: string, token: string): Promise<WalletData> {
  if (!token) return { ...emptyWallet, error: 'Add your owner token in Settings to connect to your wallet.' };
  try {
    const [ledger, connections, jobs, exposure, requests] = await Promise.all([
      walletRequest<{ entries: LedgerEntry[] }>(url, token, '/v1/ledger'),
      walletRequest<{ connections: Connection[] }>(url, token, '/v1/connections'),
      walletRequest<{ jobs: Job[] }>(url, token, '/v1/jobs'),
      walletRequest<{ exposures: Exposure[] }>(url, token, '/v1/exposure'),
      walletRequest<{ requests: PrivacyRequest[] }>(url, token, '/v1/privacy-requests'),
    ]);
    if (![ledger.entries, connections.connections, jobs.jobs, exposure.exposures, requests.requests].every(Array.isArray)) throw new Error('The wallet returned an unexpected response.');
    return { ...ledger, ...connections, ...jobs, ...exposure, ...requests, live: true };
  } catch (error) {
    return { ...emptyWallet, error: error instanceof Error && error.name !== 'TypeError' ? error.message : 'Could not reach your wallet. Check the URL and server connection permissions.' };
  }
}
