import { queryOptions } from '@tanstack/react-query';
import { makeDemoData } from './data';
export const initialWalletOptions = queryOptions({
  queryKey: ['wallet-initial'],
  queryFn: async () => makeDemoData(),
  staleTime: Infinity,
});
