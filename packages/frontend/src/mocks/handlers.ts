// MSW handlers for the Phase-2 endpoints. Each handler:
//
//   1. Parses the request body with the matching zod schema from
//      @servicebay/api-client so a frontend-only contributor finds out
//      *here* if they ship a request shape the real backend would
//      reject — the same schema the real route handler uses, just
//      enforced earlier in the dev loop.
//   2. Returns a fixture from ./fixtures.ts. Add a query-string
//      escape hatch (`?mock=…`) only when stories genuinely need the
//      bad-path response; default is the happy path.
//
// Adding a new handler:
//   - Pick (or add) the request/response schemas in api-client.
//   - Add a happy-path fixture in fixtures.ts.
//   - Register an `http.*(...)` handler here.
//   - Update packages/frontend/README.md if the endpoint is part of
//     the "what runs without a backend" list.

import { http, HttpResponse } from 'msw';
import {
  ValidateYamlRequestSchema,
  GenerateSecretRequestSchema,
  ParseDependenciesRequestSchema,
} from '@servicebay/api-client';
import {
  validYamlManifest,
  invalidYamlManifest,
  generatedSecret,
  parsedDependencies,
  idleInstallStatus,
} from './fixtures';

export const handlers = [
  // POST /api/services/validate-yaml
  // ?mock=invalid → invalidYamlManifest fixture (the parse-error path)
  http.post('/api/services/validate-yaml', async ({ request }) => {
    const body = await request.json();
    const parsed = ValidateYamlRequestSchema.safeParse(body);
    if (!parsed.success) {
      return HttpResponse.json(
        { ok: false, error: 'validation failed', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const url = new URL(request.url);
    if (url.searchParams.get('mock') === 'invalid') {
      return HttpResponse.json(invalidYamlManifest);
    }
    return HttpResponse.json(validYamlManifest);
  }),

  // POST /api/install/generate-secret
  http.post('/api/install/generate-secret', async ({ request }) => {
    const body = await request.json().catch(() => ({}));
    const parsed = GenerateSecretRequestSchema.safeParse(body);
    if (!parsed.success) {
      return HttpResponse.json(
        { ok: false, error: 'validation failed', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    return HttpResponse.json(generatedSecret);
  }),

  // POST /api/templates/parse-dependencies
  http.post('/api/templates/parse-dependencies', async ({ request }) => {
    const body = await request.json();
    const parsed = ParseDependenciesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return HttpResponse.json(
        { ok: false, error: 'validation failed', issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    return HttpResponse.json(parsedDependencies);
  }),

  // GET /api/install/status — minimal idle response so the wizard
  // doesn't endlessly poll for a job that never exists in mock mode.
  http.get('/api/install/status', () => {
    return HttpResponse.json(idleInstallStatus);
  }),

  // #971 — Expanded handler coverage for the dashboards + onboarding
  // wizard. Each handler returns a minimal happy-path shape. Storybook
  // stories can pass `?mock=...` query params for bad-path responses;
  // default is "this surface renders something plausible without a
  // backend."

  // GET /api/services — list of deployed services
  http.get('/api/services', () => HttpResponse.json([])),

  // GET /api/containers — runtime container inventory
  http.get('/api/containers', () => HttpResponse.json([])),

  // GET /api/settings — operator config bag
  http.get('/api/settings', () => HttpResponse.json({})),

  // GET /api/settings/logLevel
  http.get('/api/settings/logLevel', () => HttpResponse.json({ logLevel: 'info' })),

  // GET /api/system/version
  http.get('/api/system/version', () => HttpResponse.json({
    version: '0.0.0-mock', latest: null, hasUpdate: false,
  })),

  // GET /api/system/mode — single-node vs cluster
  http.get('/api/system/mode', () => HttpResponse.json({ mode: 'single-node' })),

  // GET /api/system/reinstall — reinstall capabilities probe
  http.get('/api/system/reinstall', () => HttpResponse.json({
    available: false, reason: 'mock mode',
  })),

  // GET /api/system/templates/upgrades-pending
  http.get('/api/system/templates/upgrades-pending', () => HttpResponse.json([])),

  // GET /api/health/checks
  http.get('/api/health/checks', () => HttpResponse.json([])),

  // GET /api/network/graph — empty topology
  http.get('/api/network/graph', () => HttpResponse.json({
    nodes: [], edges: [], metadata: { stats: {} },
  })),

  // GET /api/system/storage?node=...
  http.get('/api/system/storage', () => HttpResponse.json({
    disks: [], raids: [], lvms: [],
  })),

  // GET /api/system/devices?node=...
  http.get('/api/system/devices', () => HttpResponse.json({})),

  // GET /api/auth/me — current-user introspection (consumed by #1001)
  http.get('/api/auth/me', () => HttpResponse.json({
    authenticated: true,
    username: 'mockuser',
    displayName: 'Mock User',
    email: 'mock@example.com',
    groups: ['family'],
    source: 'forward-auth',
  })),

  // POST /api/auth/logout — clears the ServiceBay session
  http.post('/api/auth/logout', () => HttpResponse.json({ success: true })),

  // GET /api/logs/query — log viewer empty result
  http.get('/api/logs/query', () => HttpResponse.json({ success: true, logs: [] })),

  // GET /api/logs/tags
  http.get('/api/logs/tags', () => HttpResponse.json({ success: true, tags: [] })),

  // GET /api/logs/list — log-by-date files
  http.get('/api/logs/list', () => HttpResponse.json({ success: true, files: [] })),
];
