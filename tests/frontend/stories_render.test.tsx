/**
 * Mount-check every Storybook story in jsdom.
 *
 * `npm run build-storybook` only validates that webpack can compile
 * the bundle — it doesn't run the components. The proper render
 * check lives in `.github/workflows/storybook.yml` (Playwright +
 * chromium), but that needs root-installable system libs which
 * aren't on every dev box. This test fills the gap: it imports each
 * `*.stories.tsx`, wraps its component with the same global
 * decorators preview.tsx applies + any story-local decorators, and
 * mounts it via @testing-library/react in jsdom.
 *
 * What it catches (the bugs you'd otherwise only see in Storybook
 * after opening a broken story in a browser):
 *   - `Cannot read properties of null` / `is not a function` at
 *     mount (the `npmCredFallback: null` class of bug).
 *   - Missing provider / context errors.
 *   - Sync component crashes.
 *
 * What it does NOT catch (still on CI's test-storybook + Playwright):
 *   - CSS / visual regressions.
 *   - Async render errors that surface after a setTimeout / fetch
 *     resolves.
 *   - Anything depending on a real DOM API jsdom doesn't ship.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';

// `import.meta.glob` is a Vite/Vitest-specific runtime feature — TS
// doesn't ship the type by default and the `vite/client` triple-slash
// ref would pull a fresh devDep into knip's graph. Spelling the
// signature inline keeps the test self-contained.
interface ImportMetaGlobOptions { eager?: boolean }
declare global {
  interface ImportMeta {
    glob: (pattern: string, opts?: ImportMetaGlobOptions) => Record<string, unknown>;
  }
}
import { render, cleanup } from '@testing-library/react';
import { Suspense } from 'react';
import { ToastProvider } from '@/providers/ToastProvider';

// MSW handlers don't run in jsdom — Storybook's `msw-storybook-addon`
// uses the service-worker API. Replace global `fetch` with a noop so
// any handler call resolves rather than blowing up the render.
//
// Polyfill the browser-only globals jsdom doesn't ship (`ResizeObserver`,
// `EventSource`, …) — `@xyflow/react` instantiates `new ResizeObserver`
// at mount, and dashboards subscribe to `EventSource` for live updates.
// Without these, the test catches an environment shortcoming, not a
// real story bug. The real test-runner CI step runs against a real
// browser where these exist natively.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class NoopEventSource {
  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) { this.url = url; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('EventSource', NoopEventSource);
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Mock Next.js navigation hooks the same way Storybook's nextjs
// framework does for `parameters.nextjs.appDirectory: true`.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

// next/dynamic returns a noop component — the Terminal etc. dashboards
// pull this in and the real implementation chokes in jsdom.
vi.mock('next/dynamic', () => ({
  default: (..._args: any[]) => () => null,
}));

/**
 * Glob every story file via Vite's `import.meta.glob`. The glob is
 * evaluated at compile-time, so each story shows up as a separate
 * test entry below.
 */
const storyModules = import.meta.glob(
  '../../packages/frontend/src/**/*.stories.tsx',
  { eager: true },
) as Record<string, any>;

describe('Storybook stories — mount in jsdom', () => {
  for (const [filePath, mod] of Object.entries(storyModules)) {
    const meta = mod.default;
    if (!meta?.component) continue;
    const decorators: Array<(Story: any) => ReactElement> = meta.decorators ?? [];

    const Component = meta.component;

    // Each named export is a story variant.
    for (const [exportName, value] of Object.entries(mod)) {
      if (exportName === 'default') continue;
      if (!value || typeof value !== 'object') continue;
      const story = value as { args?: Record<string, unknown>; decorators?: Array<(Story: any) => ReactElement> };

      const title = meta.title ?? filePath;
      const fullDecorators = [...decorators, ...(story.decorators ?? [])];

      it(`${title} → ${exportName}`, () => {
        const Render = () => <Component {...(story.args ?? {})} />;
        // Compose decorators inside-out: the outermost decorator
        // wraps a callable Story() that itself wraps the next one.
        const decoratedTree = fullDecorators.reduceRight<ReactElement>(
          (inner, dec) => dec(() => inner) as ReactElement,
          <Render />,
        );

        // ToastProvider mirrors preview.tsx's global decorator.
        // Suspense handles components that suspend on first render.
        expect(() => {
          render(
            <ToastProvider>
              <Suspense fallback={null}>{decoratedTree}</Suspense>
            </ToastProvider>,
          );
        }).not.toThrow();
      });
    }
  }
});
