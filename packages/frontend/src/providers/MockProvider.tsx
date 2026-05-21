'use client';

// Conditional MSW boot. Tree-shakes to a no-op when
// NEXT_PUBLIC_USE_MOCKS isn't '1' — the dynamic import + env-var
// gate keeps the worker code out of the production bundle.
//
// Children render immediately (before the worker is ready). MSW
// intercepts requests once the service worker has activated, which
// happens within ~50ms on a warm browser; the first SSR fetch on
// initial page load can race that, so any handler that's
// load-bearing for first render should also have a fixture in the
// initial-data path. The current set (validate-yaml, generate-
// secret, parse-dependencies, install/status) is only hit after
// user interaction, so this race doesn't bite in practice.

import { useEffect, useState } from 'react';

interface MockProviderProps {
  children: React.ReactNode;
}

export default function MockProvider({ children }: MockProviderProps) {
  const [ready, setReady] = useState(
    process.env.NEXT_PUBLIC_USE_MOCKS !== '1',
  );

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_USE_MOCKS !== '1') return;
    let cancelled = false;
    (async () => {
      const { enableMocks } = await import('../mocks/init');
      await enableMocks();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // While the worker is starting, render nothing — the alternative is
  // letting the page hit the real network first and then having MSW
  // take over, which makes mock-mode behave inconsistently between
  // first paint and reload.
  if (!ready) return null;
  return <>{children}</>;
}
