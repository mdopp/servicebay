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
];
