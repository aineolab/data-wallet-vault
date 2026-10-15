import { useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Copy, KeyRound, LockKeyhole, Sparkles, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { scopeNames, validateWalletUrl } from '@/lib/wallet/data';

const mintScopes = ['work_profile', 'coding_preferences', 'shopping_preferences', 'personal_memory', 'health_finance_restricted'];
const prompts = ['Get my LinkedIn data into my wallet.', 'Is my LinkedIn import done? What did it find?', 'Who read my wallet today?'];

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <Button variant="outline" className="h-11 shrink-0" onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable */ } }}>{done ? <Check /> : <Copy />}{done ? 'Copied' : label}</Button>;
}
function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  return <div className="flex flex-col gap-2 sm:flex-row"><input readOnly value={value} className={cn('wallet-input flex-1', mono && 'font-mono text-sm')} onFocus={e => e.currentTarget.select()} /><CopyButton value={value} /></div>;
}

export function ConnectAgent({ url, ownerToken, isLive, onOpenConnections }: { url: string; ownerToken: string; isLive: boolean; onOpenConnections: () => void }) {
  const base = url || 'https://your-wallet-server.vercel.app';
  const mcpUrl = `${base}/mcp`;
  const [name, setName] = useState('Claude Code');
  const [scopes, setScopes] = useState<string[]>(['work_profile', 'coding_preferences']);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState('');
  const [minted, setMinted] = useState<{ token: string; fake: boolean } | null>(null);
  const command = `claude mcp add --transport http wallet ${mcpUrl} --header "Authorization: Bearer ${minted?.token ?? '<YOUR_TOKEN>'}"`;
  const fakeToken = () => `demo_${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')}`;

  async function mint(e: React.FormEvent) {
    e.preventDefault(); setError(''); setMinted(null);
    if (!name.trim()) { setError('Give this consumer a name.'); return; }
    if (!scopes.length) { setError('Tick at least one scope.'); return; }
    if (!url) { setMinted({ token: fakeToken(), fake: true }); return; }
    setMinting(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
      const res = await fetch(`${validateWalletUrl(url)}/v1/tokens/issue`, { method: 'POST', headers, body: JSON.stringify({ consumer_name: name.trim(), consumer_type: 'AI_AGENT_MCP', scopes }), signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'Owner token was not accepted. Check your token in Settings.' : `Token request failed (${res.status}).`);
      const body = await res.json() as { token?: string; access_token?: string; raw_token?: string };
      const token = body.token ?? body.access_token ?? body.raw_token;
      if (!token) throw new Error('The wallet did not return a token.');
      setMinted({ token, fake: false });
    } catch (err) {
      if (!isLive) setMinted({ token: fakeToken(), fake: true });
      else setError(err instanceof Error && err.name !== 'TypeError' ? err.message : 'Could not reach your wallet.');
    } finally { setMinting(false); }
  }

  return <div className="space-y-6">
    <div><h2 className="text-3xl font-medium">Connect Claude to your wallet</h2><p className="mt-2 text-base text-muted-foreground">Your agents read only the scopes you grant. Every read lands on the statement.</p></div>

    <article className="connection-card space-y-5">
      <div className="flex items-center gap-3"><span className="connection-symbol"><Sparkles size={24} /></span><h3 className="text-2xl font-semibold">Claude (claude.ai) — OAuth</h3></div>
      <div><p className="mb-2 text-xs uppercase text-muted-foreground">Wallet MCP endpoint</p><CopyField value={mcpUrl} /></div>
      <ol className="list-decimal space-y-2 pl-6 text-base">
        <li>In claude.ai go to Settings → Connectors → Add custom connector</li>
        <li>Paste the URL above</li>
        <li>On the wallet consent page, enter your owner passphrase and tick the scopes you want to grant. Health & finance stays off unless you tick it.</li>
      </ol>
      <p className="text-sm text-muted-foreground">Consent writes a grant; revoke it any time from Connections.</p>
    </article>

    <article className="connection-card space-y-5">
      <div className="flex items-center gap-3"><span className="connection-symbol"><Terminal size={24} /></span><h3 className="text-2xl font-semibold">Claude Code — bearer token</h3></div>
      <CopyField value={command} />
      <form onSubmit={mint} className="space-y-4 border-t pt-5">
        <h4 className="flex items-center gap-2 text-lg font-semibold"><KeyRound size={18} />Mint a consumer token</h4>
        <label className="block text-sm font-medium" htmlFor="consumer-name">Consumer name</label>
        <input id="consumer-name" className="wallet-input w-full" value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
        <fieldset><legend className="mb-2 text-sm font-medium">Scopes</legend><div className="grid gap-2 sm:grid-cols-2">{mintScopes.map(s => { const restricted = s === 'health_finance_restricted'; return <label key={s} className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2"><input type="checkbox" className="size-5 accent-[hsl(var(--primary))]" checked={scopes.includes(s)} onChange={e => setScopes(old => e.target.checked ? [...old, s] : old.filter(x => x !== s))} /><span className="flex-1">{s}<span className="block text-xs text-muted-foreground">{scopeNames[s]}</span></span>{restricted && <span className="scope-chip scope-restricted"><LockKeyhole size={12} />restricted</span>}</label>; })}</div></fieldset>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Button type="submit" className="h-12 text-base" disabled={minting}><KeyRound />{minting ? 'Minting…' : 'Mint token'}</Button>
      </form>
      {minted && <div className="space-y-3 rounded-md border p-4">
        {minted.fake && <div role="status" className="connection-alert !m-0"><AlertTriangle size={18} /><span>Demo mode: this token is not real</span></div>}
        <CopyField value={minted.token} />
        <p className="flex items-center gap-2 text-sm text-warning"><AlertTriangle size={15} />Shown once. Not stored.</p>
        <p className="text-sm text-muted-foreground">The command above now includes this token.</p>
        <Button variant="outline" className="h-11" onClick={onOpenConnections}>View in Connections <ArrowRight /></Button>
      </div>}
    </article>

    <article className="connection-card space-y-4">
      <h3 className="text-2xl font-semibold">Start pulling data in</h3>
      <p className="text-sm text-muted-foreground">Once connected, paste one of these into Claude.</p>
      {prompts.map(p => <div key={p} className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between"><span className="text-lg">“{p}”</span><CopyButton value={p} /></div>)}
    </article>
  </div>;
}
