// Test setup — applied via vitest.config.ts `setupFiles`.
//
// React Testing Library defaults `waitFor` / `findBy*` to 1000 ms.
// That's tight when a single test exercises a longer pipeline; lift
// the floor to 5 s so realistic slow paths converge without forcing
// per-spec `{ timeout }` overrides. Fast assertions remain fast —
// waitFor still returns the moment its callback succeeds.
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });
