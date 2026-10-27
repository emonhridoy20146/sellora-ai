'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Toaster, toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api/errors';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Do not retry what will fail again (auth, permissions, validation, not found).
        retry: (count, err) =>
          count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      },
    },
    queryCache: new QueryCache(),
    mutationCache: new MutationCache({
      // Every failed write tells the person why, unless the form shows the error itself.
      onError: (err, _vars, _ctx, mutation) => {
        if (mutation.meta?.silent) return;
        toast.error(errorMessage(err));
      },
    }),
  });
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean };
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeClient);
  // The chat widget sits on merchants' sites inside a transparent iframe; a dark colour
  // scheme there would paint the iframe opaque, so it is always light.
  const forcedTheme = usePathname().startsWith('/widget/') ? 'light' : undefined;
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={forcedTheme}
    >
      <QueryClientProvider client={client}>
        {children}
        <Toaster richColors closeButton position="top-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
