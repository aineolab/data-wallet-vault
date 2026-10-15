import { queryOptions } from '@tanstack/react-query';
import { configuredUrl, emptyWallet, makeDemoData } from './data';
export const initialWalletOptions = queryOptions({
  queryKey: ['wallet-initial'],
  queryFn: async () => configuredUrl ? emptyWallet : makeDemoData(),
  staleTime: Infinity,
});
