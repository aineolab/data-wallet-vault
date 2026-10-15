import { createFileRoute } from '@tanstack/react-router';
import { WalletDashboard } from '@/components/wallet/dashboard';
import { initialWalletOptions } from '@/lib/wallet/queries';

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { tab: 'statement' | 'connections' | 'imports' | 'online' | 'connect' } => ({ tab: search['tab'] === 'connections' || search['tab'] === 'imports' || search['tab'] === 'online' || search['tab'] === 'connect' ? search['tab'] : 'statement' }),
  loader: ({ context }) => context.queryClient.ensureQueryData(initialWalletOptions),
  head: () => ({ meta: [
    { title: 'Data Wallet — Dana Whitfield’s owner dashboard' },
    { name: 'description', content: 'Control wallet access, follow data imports, and review privacy requests in the Data Wallet owner dashboard.' },
    { property: 'og:title', content: 'Data Wallet — Your wallet. Your rules.' },
    { property: 'og:description', content: 'Your data lives here. Your AIs ask; you decide.' },
    { property: 'og:type', content: 'website' },
    { name: 'twitter:card', content: 'summary_large_image' },
  ] }),
  component: Index,
  errorComponent: () => <div role="alert" className="p-10 text-foreground">The wallet dashboard could not load. Please refresh to try again.</div>,
  notFoundComponent: () => <div className="p-10 text-foreground">Wallet view not found.</div>,
});
function Index() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return <WalletDashboard tab={tab} onTabChange={tab => navigate({ search: { tab } })} />;
}
