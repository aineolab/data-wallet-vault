import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Activity, ArrowDownLeft, ArrowRight, Check, CheckCheck, ChevronRight, Circle, Database, Download, Fingerprint, Globe2, Link2, LockKeyhole, RefreshCw, Settings2, ShieldCheck, Sparkles, Unplug, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { configuredUrl, fetchWallet, scopeNames, validateWalletUrl, walletRequest, type Connection, type Job, type WalletData } from '@/lib/wallet/data';
import { initialWalletOptions } from '@/lib/wallet/queries';

type Tab = 'statement' | 'connections' | 'imports' | 'online';
const tabs = [{ id: 'statement', label: 'Statement', icon: Activity }, { id: 'connections', label: 'Connections', icon: Link2 }, { id: 'imports', label: 'Imports', icon: Download }, { id: 'online', label: 'My data online', icon: Globe2 }] as const;
export function formatDate(value?: string | null) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
function elapsed(value: string) { const mins = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)); if (!Number.isFinite(mins)) return '—'; return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.floor(mins / 1440)}d`; }
function pretty(value: string) { return value.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function operationLabel(value: string) { return ({ search: 'Searched memories', search_memories: 'Searched memories', read_identity_card: 'Read identity card', blocked_out_of_scope: 'Blocked: out of scope', access_revoked: 'Access revoked', data_shipped: 'Data shipped', resale_blocked: 'Resale blocked', linkedin_drift_check: 'LinkedIn drift check' } as Record<string, string>)[value] ?? (value.includes('_') ? pretty(value) : value); }
function Chip({ scope }: { scope: string }) { const restricted = scope === 'health_finance_restricted'; return <span title={scope} className={cn('scope-chip', restricted && 'scope-restricted')}>{restricted && <LockKeyhole size={12} />}{scopeNames[scope] ?? pretty(scope)}</span>; }
function Scopes({ scopes }: { scopes: string[] }) { return <div className="flex flex-wrap gap-1.5">{scopes.length ? scopes.map(s => <Chip key={s} scope={s} />) : <span className="text-muted-foreground">None</span>}</div>; }

export function WalletDashboard({ tab, onTabChange }: { tab: Tab; onTabChange: (tab: Tab) => void }) {
  const { data: initialData } = useSuspenseQuery(initialWalletOptions);
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState({ url: configuredUrl, token: '' });
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(false);
  const [draftUrl, setDraftUrl] = useState(configuredUrl || 'https://data-wallet-server-nyolab.vercel.app');
  const [draftToken, setDraftToken] = useState('');
  const [testState, setTestState] = useState('');
  const [testing, setTesting] = useState(false);
  const [demo, setDemo] = useState(initialData);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState('');
  const [justRevoked, setJustRevoked] = useState<string[]>([]);
  useEffect(() => {
    try {
      const token = sessionStorage.getItem('wallet-owner-token') ?? '';
      const url = configuredUrl ? sessionStorage.getItem('wallet-server-url') || configuredUrl : '';
      setCredentials({ url, token }); setDraftUrl(url || configuredUrl); setDraftToken(token);
    } catch { setTestState('Session storage is unavailable. Your token will not be saved.'); }
    setReady(true);
  }, []);
  const liveQuery = useQuery({ queryKey: ['wallet-live', credentials.url], queryFn: () => fetchWallet(credentials.url, credentials.token), enabled: ready && Boolean(configuredUrl && credentials.token), refetchInterval: 3000, refetchIntervalInBackground: true, retry: false });
  const isLive = Boolean(configuredUrl && credentials.token && liveQuery.data?.live);
  const data: WalletData = isLive && liveQuery.data ? liveQuery.data : demo;
  const disconnected = false;
  const activeCount = data.connections.filter(c => !c.is_revoked).length;
  const blockedCount = data.entries.filter(e => /block|denied/i.test(e.operation)).length;
  const pendingCount = data.requests.filter(r => !['completed', 'data received'].includes(r.status.toLowerCase())).length;

  async function testConnection() {
    setTesting(true); setTestState('');
    try {
      const url = validateWalletUrl(draftUrl);
      const res = await fetch(`${url}/health`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (!res.ok) throw new Error(`Health check failed (${res.status}).`);
      const health = await res.json() as { ok?: unknown; db?: unknown; tables?: unknown };
      const summary = `ok: ${String(health.ok)} · db: ${String(health.db ?? '—')} · tables: ${String(health.tables ?? '—')}`;
      if (!draftToken.trim()) { setTestState(`${summary}. Paste your owner token to go live.`); return; }
      await walletRequest(url, draftToken.trim(), '/v1/ledger');
      sessionStorage.setItem('wallet-owner-token', draftToken.trim());
      sessionStorage.setItem('wallet-server-url', url);
      queryClient.removeQueries({ queryKey: ['wallet-live'] });
      setCredentials({ url, token: draftToken.trim() });
      setTestState(`${summary}. Owner token accepted.`);
    } catch (error) { setTestState(error instanceof Error && error.name !== 'TypeError' ? error.message : 'Could not reach your wallet. Check its URL and connection permissions.'); }
    finally { setTesting(false); }
  }
  function clearToken() {
    try { sessionStorage.removeItem('wallet-owner-token'); sessionStorage.removeItem('wallet-server-url'); } catch { /* session is already unavailable */ }
    setCredentials({ url: configuredUrl, token: '' }); setDraftToken(''); queryClient.removeQueries({ queryKey: ['wallet-live'] }); setTestState('Owner token cleared.');
  }
  async function revoke(connection: Connection) {
    setRevoking(connection.token_id); setRevokeError('');
    try {
      if (isLive) {
        await walletRequest(credentials.url, credentials.token, `/v1/tokens/${encodeURIComponent(connection.token_id)}`, 'DELETE');
        queryClient.setQueryData<WalletData>(['wallet-live', credentials.url], old => old ? { ...old, connections: old.connections.map(c => c.token_id === connection.token_id ? { ...c, is_revoked: true } : c) } : old);
        await liveQuery.refetch();
      } else {
        setDemo(old => ({ ...old, connections: old.connections.map(c => c.token_id === connection.token_id ? { ...c, is_revoked: true } : c), entries: [{ created_at: new Date().toISOString(), consumer_name: connection.consumer_name, operation: 'Access revoked', scopes_requested: connection.allowed_scopes, scopes_served: [], records_returned: 0 }, ...old.entries] }));
      }
      setJustRevoked(old => [...old, connection.token_id]); setConfirmId(null);
    } catch (error) { setRevokeError(error instanceof Error ? error.message : 'Revocation failed. Please try again.'); }
    finally { setRevoking(null); }
  }
  return <main className="wallet-page">
    <header className="wallet-header">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-5 py-5 md:px-10">
        <div className="flex items-center gap-3"><span className="brand-mark"><Wallet size={24} strokeWidth={1.7} /></span><span className="text-xl font-semibold">Data Wallet<span className="ml-3 hidden text-xs font-normal uppercase tracking-normal text-muted-foreground sm:inline">Owner console</span></span></div>
        <div className="flex items-center gap-3 md:gap-5"><span className="hidden text-sm text-muted-foreground sm:inline">Dana Whitfield</span><span className="owner-avatar" aria-label="Dana Whitfield">DW</span><Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Settings" title="Settings" onClick={() => setSettings(true)}><Settings2 className="size-5" /></Button></div>
      </div>
    </header>
    <div className="mx-auto max-w-[1440px] px-5 pb-10 md:px-10">
      <section className="intro-section">
        <div className="flex flex-wrap items-center gap-3"><span className="eyebrow">DANA WHITFIELD’S WALLET</span><span className={cn('status-pill', disconnected && 'status-disconnected')}><span className="status-dot" />{isLive ? 'Live' : 'Demo data'}</span></div>
        <h1 className="mt-5 text-4xl font-medium md:text-5xl">Your data lives here.<br className="sm:hidden" /> <span className="text-muted-foreground">Your AIs ask; you decide.</span></h1>
        <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck size={16} className="text-primary" /><span>Private by default. Shared on your terms.</span></div>
      </section>
      {!isLive && <div role="status" className="connection-alert"><LockKeyhole size={20} /><span>{credentials.token && liveQuery.isFetching && !liveQuery.data ? 'Connecting to your wallet…' : 'Paste your owner token in Settings to go live'}</span><Button variant="outline" onClick={() => setSettings(true)}>Settings <ArrowRight /></Button></div>}
      <section className="summary-strip" aria-label="Wallet overview">
        <Summary icon={Activity} label="Wallet activity" value={data.entries.length} detail="reads & events" />
        <Summary icon={Link2} label="Connections" value={activeCount} detail="with access" />
        <Summary icon={LockKeyhole} label="Requests blocked" value={blockedCount} detail="boundaries held" accent />
        <Summary icon={Globe2} label="Privacy requests" value={pendingCount} detail="in progress" />
      </section>
      <nav className="tab-bar" aria-label="Wallet tabs"><div className="tab-items" role="tablist">{tabs.map(t => <Button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} variant="ghost" className={cn('wallet-tab', tab === t.id && 'wallet-tab-active')} onClick={() => onTabChange(t.id)}><t.icon size={19} />{t.label}{t.id === 'connections' && <span className="tab-count">{data.connections.length}</span>}</Button>)}</div><span className="hidden items-center gap-2 text-xs text-muted-foreground lg:flex"><span className={cn('status-dot', !isLive && 'dot-muted')} />{isLive ? 'Updating every 3 seconds' : 'Demo workspace'}</span></nav>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === 'statement' && <>
          <SectionHeading title="Your wallet statement" subtitle="Every request. Every decision. Nothing behind your back." aside={<span className="text-sm text-muted-foreground">{data.entries.length} events <span className="mx-2 text-border">/</span> Newest first</span>} />
          <div className="ledger-table"><div className="ledger-head"><span>TIME</span><span>WHO & WHAT</span><span>CATEGORIES ASKED → SERVED</span><span className="text-right">RECORDS</span></div>
            {[...data.entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((entry, i) => { const blocked = /block|denied/i.test(entry.operation); const revoked = /revok/i.test(entry.operation); return <div key={`${entry.created_at}-${entry.consumer_name}-${i}`} className={cn('ledger-row', blocked && 'ledger-blocked')}>
              <div className="ledger-time"><span>{new Date(entry.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span><span className="text-xs text-muted-foreground">{formatDate(entry.created_at)}</span></div>
              <div className="flex min-w-0 items-center gap-3"><span className={cn('event-icon', blocked && 'event-blocked', revoked && 'event-revoked')}>{blocked ? <LockKeyhole size={18} /> : revoked ? <Unplug size={18} /> : /shipped/i.test(entry.operation) ? <ArrowRight size={18} /> : <ArrowDownLeft size={18} />}</span><div className="min-w-0"><p className="text-base font-semibold">{entry.consumer_name}</p><p className={cn('mt-1 text-sm text-muted-foreground', blocked && 'text-warning')}>{operationLabel(entry.operation)}</p></div></div>
              <div className="ledger-scopes"><Scopes scopes={entry.scopes_requested} /><ArrowRight className="shrink-0 text-muted-foreground" size={14} />{blocked ? <span className="flex items-center gap-1.5 text-sm text-warning"><LockKeyhole size={13} />Nothing shared</span> : <Scopes scopes={entry.scopes_served} />}</div>
              <div className="ledger-records"><span className={cn('text-xl font-medium', blocked && 'text-warning')}>{entry.records_returned}</span><span className="text-xs text-muted-foreground sm:hidden"> records</span></div>
            </div>; })}
          </div>{!data.entries.length && <EmptyState label={isLive ? 'No wallet events to show.' : 'No activity yet.'} />}
          <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground"><Fingerprint size={15} /><span>A record of access, not a copy of your personal data.</span></div>
        </>}
        {tab === 'connections' && <>
          <SectionHeading title="Who has access" subtitle="You set the boundaries. You can change your mind." aside={<span className="flex items-center gap-2 text-sm text-primary"><ShieldCheck size={17} />{activeCount} connected</span>} />
          {revokeError && <p role="alert" className="mb-4 text-destructive">{revokeError}</p>}
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{data.connections.map(c => <article key={c.token_id} className={cn('connection-card', c.is_revoked && 'connection-revoked')}>
            <div className="flex items-start justify-between gap-3"><span className="connection-symbol">{c.consumer_type.includes('buyer') ? <Database size={26} /> : <Sparkles size={26} />}</span><span className={cn('status-pill', c.is_revoked && 'status-neutral')}>{c.is_revoked ? 'Revoked' : c.status === 'shipped' ? 'Shipped' : 'Active'}</span></div>
            <h3 className="mt-5 text-2xl font-semibold">{c.consumer_name}</h3><p className="mt-1 text-sm text-muted-foreground">{c.consumer_type.includes('buyer') ? 'Data buyer' : 'AI agent'}{c.exclusive && <span className="ml-2 text-warning">· Exclusive</span>}</p>
            <div className="my-6 min-h-16"><p className="mb-3 text-xs uppercase text-muted-foreground">Allowed categories</p><Scopes scopes={c.allowed_scopes} /></div>
            <div className="mb-5 flex justify-between gap-2 border-t pt-4 text-sm"><span className="text-muted-foreground">Expires</span><span>{c.expires_at ? formatDate(c.expires_at) : 'No expiry'}</span></div>
            {c.is_revoked ? <div className="flex h-12 items-center justify-center gap-2 rounded-md bg-muted text-muted-foreground"><Unplug size={17} />{justRevoked.includes(c.token_id) ? 'Revoked just now' : 'Access revoked'}</div> : confirmId === c.token_id ? <div className="space-y-3" role="group" aria-label={`Confirm revocation for ${c.consumer_name}`}><p className="text-sm">Revoke {c.consumer_name}’s access?</p><div className="flex gap-2"><Button variant="outline" className="h-12 flex-1" disabled={Boolean(revoking)} onClick={() => setConfirmId(null)}>Cancel</Button><Button variant="destructive" className="h-12 flex-1 text-base" disabled={Boolean(revoking)} onClick={() => revoke(c)}>{revoking ? 'Revoking…' : 'Confirm revoke'}</Button></div></div> : <Button variant="destructive" className="h-12 w-full text-base" disabled={disconnected} onClick={() => { setConfirmId(c.token_id); setRevokeError(''); }}><Unplug size={18} />Revoke</Button>}
          </article>)}</div>{!data.connections.length && <EmptyState label="No connections to show." />}
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole size={17} />Health & money (never shared by default)</div>
        </>}
        {tab === 'imports' && <><SectionHeading title="Your data, brought together" subtitle="Follow your imports from request to wallet." aside={<span className="text-sm text-muted-foreground">{data.jobs.length} imports</span>} /><div>{data.jobs.map(job => <ImportJob key={job.id} job={job} />)}</div>{!data.jobs.length && <EmptyState label="No import jobs to show." />}</>}
        {tab === 'online' && <>
          <SectionHeading title="Your footprint online" subtitle="Where your data appears. What’s being done about it." aside={<span className="flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole size={15} />Read-only · Actions in Claude</span>} />
          <div className="exposure-wrap"><table className="exposure-table"><thead><tr>{['SITE / TYPE', 'WHAT IT SHOWS', 'RISK / CONFIDENCE', 'RECOMMENDED ACTION', 'REQUEST STATUS'].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{data.exposures.map(e => { const site = e.site ?? e.site_name ?? 'Unknown site'; const request = data.requests.find(r => r.exposure_id === e.id || (r.site ?? r.site_name) === site); const risk = (e.risk ?? e.risk_level ?? 'low').toLowerCase(); const namesake = e.is_namesake || String(e.confidence).toLowerCase().includes('not you'); return <tr key={e.id}><td><p className="font-semibold">{site}</p><p className="mt-1 text-sm text-muted-foreground">{e.type ?? e.exposure_type}</p></td><td><div className="flex flex-wrap gap-1.5">{(e.data_shown ?? e.data_types ?? []).map(s => <span key={s} className="scope-chip">{s}</span>)}</div></td><td><span className={cn('risk-badge', risk === 'high' ? 'risk-high' : risk === 'medium' ? 'risk-medium' : 'risk-low')}><span className="status-dot" />{pretty(risk)}</span><p className="mt-2 text-xs text-muted-foreground">{namesake ? 'Namesake · probably not you' : typeof e.confidence === 'number' ? `${Math.round(e.confidence <= 1 ? e.confidence * 100 : e.confidence)}% match` : e.confidence}</p></td><td><span className="text-sm">{e.recommended_action ?? '—'}</span></td><td>{request ? <><span className={cn('request-status', /overdue|escalated/i.test(request.status) && 'text-destructive')}><span className="status-dot" />{pretty(request.status)}</span><p className="mt-2 text-xs text-muted-foreground">{request.request_type && `${pretty(request.request_type)}${request.due_at || request.due_date ? ' · ' : ''}`}{request.due_at || request.due_date ? `Due ${formatDate(request.due_at ?? request.due_date)}` : 'No due date'}</p></> : <span className="text-sm text-muted-foreground">{namesake ? 'No action' : 'Monitoring'}</span>}</td></tr>; })}</tbody></table></div>{!data.exposures.length && <EmptyState label="No online exposures to show." />}
        </>}
      </div>
      <footer className="wallet-footer"><span className="flex items-center gap-2"><ShieldCheck size={16} />Your wallet. Your rules.</span><span>{isLive ? 'Data Wallet owner console' : 'Fictional data · Dana Whitfield'}</span></footer>
    </div>
    <Dialog open={settings} onOpenChange={setSettings}><DialogContent className="w-[calc(100%-2rem)] max-w-xl"><DialogHeader><DialogTitle className="text-2xl">Wallet settings</DialogTitle><DialogDescription>Your connection to the wallet server.</DialogDescription></DialogHeader><label className="mt-3 text-sm font-medium" htmlFor="wallet-url">Wallet server URL</label><input className="wallet-input" id="wallet-url" type="url" value={draftUrl} onChange={e => setDraftUrl(e.target.value)} placeholder="https://your-wallet-server.vercel.app" autoComplete="off" /><label className="text-sm font-medium" htmlFor="owner-token">Owner token</label><input className="wallet-input" id="owner-token" type="password" value={draftToken} onChange={e => setDraftToken(e.target.value)} placeholder="Paste your owner token" autoComplete="off" /><p className="text-sm text-muted-foreground">Kept only for this browser session. Never stored permanently.</p>{!isLive && <p className="text-sm text-warning">Demo data is active until your owner token is accepted.</p>}{testState && <p role="status" className="text-sm">{testState}</p>}<div className="mt-3 flex flex-wrap justify-between gap-3"><Button variant="ghost" onClick={clearToken}>Clear token</Button><Button className="h-11 text-base" disabled={testing} onClick={testConnection}>{testing ? <RefreshCw className="animate-spin" /> : <Link2 />}{testing ? 'Testing…' : 'Test connection'}</Button></div></DialogContent></Dialog>
  </main>;
}
function Summary({ icon: Icon, label, value, detail, accent = false }: { icon: typeof Activity; label: string; value: number; detail: string; accent?: boolean }) { return <div className="summary-item"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon size={17} />{label}</div><div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className={cn('text-3xl font-medium md:text-4xl', accent && 'text-warning')}>{value.toString().padStart(2, '0')}</span><span className="text-xs text-muted-foreground md:text-sm">{detail}</span></div></div>; }
function SectionHeading({ title, subtitle, aside }: { title: string; subtitle: string; aside?: React.ReactNode }) { return <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-2xl font-medium">{title}</h2><p className="mt-2 text-sm text-muted-foreground md:text-base">{subtitle}</p></div>{aside}</div>; }
function EmptyState({ label }: { label: string }) { return <div className="flex min-h-48 flex-col items-center justify-center gap-3 border-b text-muted-foreground"><Database size={28} /><p>{label}</p></div>; }
export function jobStep(state: string) { return ({ requested: 0, pending: 0, waiting: 1, waiting_for_linkedin: 1, waiting_for_provider: 1, archive_ready: 2, ready: 2, importing: 3, done: 4, completed: 4 } as Record<string, number>)[state.toLowerCase().replace(/ /g, '_')] ?? -1; }
function ImportJob({ job }: { job: Job }) {
  const step = jobStep(job.state); const terminal = /cancelled|canceled|expired|failed/i.test(job.state); const labels = ['Requested', 'Waiting for LinkedIn', 'Archive ready', 'Importing', 'Done'];
  return <article className="import-job"><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><span className="linkedin-mark">in</span><div><h3 className="text-xl font-semibold">{job.provider} data import</h3><p className="mt-1 text-sm text-muted-foreground">Started {formatDate(job.created_at)} · {elapsed(job.created_at)} ago</p></div></div><span className={cn('status-pill', terminal && 'status-failed')}>{terminal && <X size={13} />}{terminal ? pretty(job.state) : step === 4 ? <><CheckCheck size={15} />Done</> : <><span className="status-dot" />{pretty(job.state)}</>}</span></div>
    <ol className="step-tracker">{labels.map((label, i) => <li key={label} className={cn('import-step', i < step && 'step-complete', i === step && !terminal && 'step-current', terminal && 'step-terminal')}><span className="step-node">{i < step || (i === 4 && step === 4) ? <Check size={17} /> : i === step && !terminal ? <span className="step-inner" /> : <Circle size={10} />}</span><span>{label.replace('LinkedIn', job.provider)}</span></li>)}</ol>
    {step === 4 && job.summary && <div className="import-summary"><span className="flex items-center gap-2 text-primary"><CheckCheck size={18} />Added to your wallet</span><span><strong>{job.summary.roles ?? 0}</strong> roles</span><span><strong>{job.summary.skills ?? 0}</strong> skills</span><span><strong>{job.summary.connections_counted ?? job.summary.connections ?? 0}</strong> connections counted <span className="text-muted-foreground">(names not stored)</span></span></div>}
  </article>;
}
