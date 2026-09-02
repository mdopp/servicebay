# @servicebay/frontend

The UI surface for ServiceBay — components, hooks, dashboards, providers, the install wizard. Phase 3 of [#753](https://github.com/mdopp/servicebay/issues/753) moved this into its own workspace package.

## Run the frontend on its own port

```bash
# From the repo root:
npm run dev:frontend
```

That starts Next.js on **port 3001** against a **real backend** — it is the Next dev server alone, so anything it renders that needs API data wants `npm run dev` (port 3000) running alongside it, or a box to talk to.

There is no mock mode any more: the MSW layer (`src/mocks/`, `MockProvider`, the `msw` dependency, `NEXT_PUBLIC_USE_MOCKS`) was removed in #2729. It covered 26 of 174 routes and no test used it, so "the frontend without a backend" was already mostly broken. If you need a backendless UI loop again, write it as a test (the frontend suite renders pages against stubbed fetches) rather than as a second, silently-rotting API implementation.

The full integrated dev path is `npm run dev` (port 3000, custom server in `server.ts`, all the way down to a real agent socket).

## Layout

```
packages/frontend/
├── src/
│   ├── components/              # React components, including wizard
│   ├── dashboards/              # Top-level pages (Network, Services, Health, …)
│   ├── hooks/                   # Custom hooks
│   └── providers/               # Toast, digital twin, …
└── package.json
```

## Files NOT to edit from a frontend-only PR

These are owned by the backend dev. Changes to them go through the backend test suite + integration tests, not the frontend dev loop:

- `packages/backend/**` — agent, install, diagnose, network, store.
- `packages/api-client/**` — the typed contract. Both sides depend on these schemas; widening or narrowing one is a backend-author decision.
- `src/app/api/**` — Next.js route handlers. Hand-rolled validation lives here.

If a frontend feature needs a new endpoint or a wider response shape, **the schema in `@servicebay/api-client` is the place to start the conversation** — that change is what unlocks both the frontend caller and the real route handler in `src/app/api/`.

## Note on Storybook

A Storybook integration was scoped, partially landed (PR #790 in 4.13.0), and then **rolled back** — the cost-benefit didn't make sense for the team shape (solo dev). Storybook's main value is team collaboration (designers without backend, FE hires without onboarding). The webpack stubbing required to keep backend code out of the browser bundle was fragile against Storybook + Next 16 + the api-client's `export type * from '@/lib/...'` re-export chain, and rendering bugs kept slipping past the build.

The same reasoning retired the in-app component catalog at `/dev/components` (#2729): a second rendering surface only pays for itself when more than one person browses it.
