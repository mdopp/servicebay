// Browser-side MSW setup. Only imported from `./init.ts` when the
// `NEXT_PUBLIC_USE_MOCKS=1` env var is set at build time, so the
// production bundle never ships the worker code.

import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker = setupWorker(...handlers);
