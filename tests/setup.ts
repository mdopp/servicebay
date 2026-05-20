// Test setup — applied via vitest.config.ts `setupFiles`.
//
// React Testing Library defaults `waitFor` / `findBy*` to a 1000ms
// timeout. That's tight on a hot local box and routinely under-budget
// on GitHub-hosted CI runners, where the microtask scheduler is
// slower (the OnboardingWizard install pipeline reliably finishes in
// ~2.5s locally but has timed out under the default budget 3+ times
// in flake #757). Lift the floor to 10s so genuinely slow paths get
// time to settle without forcing per-spec `{ timeout }` overrides
// everywhere. Fast assertions remain fast — waitFor still returns
// the moment its callback succeeds.
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 10_000 });
