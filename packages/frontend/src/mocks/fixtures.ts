// Fixture data backing the MSW handlers. Kept in one file so adding
// a story / Storybook variant only needs to import a named fixture
// rather than re-creating one inline. Every fixture is shaped to
// pass the matching zod schema in `@servicebay/api-client`.

import type { z } from 'zod';
import {
  ValidateYamlResponseSchema,
  GenerateSecretResponseSchema,
  ParseDependenciesResponseSchema,
  InstallStatusResponseSchema,
} from '@servicebay/api-client';

type ValidateYamlResponse = z.infer<typeof ValidateYamlResponseSchema>;
type GenerateSecretResponse = z.infer<typeof GenerateSecretResponseSchema>;
type ParseDependenciesResponse = z.infer<typeof ParseDependenciesResponseSchema>;
type InstallStatusResponse = z.infer<typeof InstallStatusResponseSchema>;

// ---------------------------------------------------------------------------
// validate-yaml fixtures
// ---------------------------------------------------------------------------

export const validYamlManifest: ValidateYamlResponse = {
  ok: true,
  manifest: {
    kind: 'Pod',
    metadata: { name: 'example-service' },
    spec: {
      containers: [
        {
          name: 'app',
          image: 'docker.io/library/nginx:alpine',
          ports: [{ containerPort: 80, hostPort: 8080, protocol: 'TCP' }],
          volumeMounts: [{ name: 'data', mountPath: '/usr/share/nginx/html' }],
        },
      ],
      volumes: [
        { name: 'data', hostPath: { path: '/mnt/data/example/html' } },
      ],
    },
  },
};

export const invalidYamlManifest: ValidateYamlResponse = {
  ok: false,
  error: {
    message: "unexpected token at line 4: expected ':' got '}'",
    line: 4,
    column: 18,
    raw: "  ports: [ 80 } ]",
  },
};

// ---------------------------------------------------------------------------
// generate-secret fixture — deterministic for stable Storybook screenshots.
// Real backend produces crypto.randomBytes(32) → 32-byte hex string.
// ---------------------------------------------------------------------------

export const generatedSecret: GenerateSecretResponse = {
  secret: 'mockedsecretmockedsecretmockedsecretmockedsecretmockedsecretmocke',
};

// ---------------------------------------------------------------------------
// parse-dependencies fixture
// ---------------------------------------------------------------------------

export const parsedDependencies: ParseDependenciesResponse = {
  dependencies: ['auth', 'nginx'],
};

// ---------------------------------------------------------------------------
// install/status — minimal shape that satisfies the schema and lets
// the wizard land on "idle, no job" by default.
// ---------------------------------------------------------------------------

export const idleInstallStatus: InstallStatusResponse = {
  job: null,
  jobIsActive: false,
  stackSetupPending: false,
  serverStartedAt: '2026-05-21T10:00:00.000Z',
};
