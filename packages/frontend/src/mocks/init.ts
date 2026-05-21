// Conditional MSW entrypoint. Imported by the root layout under a
// `process.env.NEXT_PUBLIC_USE_MOCKS === '1'` guard so the worker
// only loads in mock mode — production bundles see this file's
// `enableMocks` as a no-op.
//
// Note: the worker registration is deliberately not awaited on every
// page load — `worker.start()` returns a promise that resolves once
// the service worker has activated. We log when ready and let
// React continue rendering; the first few requests in a fresh tab
// might race the worker, but every subsequent reload is fully mocked.

export async function enableMocks(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (process.env.NEXT_PUBLIC_USE_MOCKS !== '1') return;

  const { worker } = await import('./browser');
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: {
      url: '/mockServiceWorker.js',
    },
  });
   
  console.info(
    '[mocks] MSW worker active — every fetch is being mocked. ' +
    'Disable by clearing NEXT_PUBLIC_USE_MOCKS.',
  );
}
