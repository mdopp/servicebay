// Install / stack-runner types shared between the frontend and the
// backend. The frontend imports from here instead of reaching into
// `@/lib/install/*`; the `sb/no-fe-backend-import` rule enforces
// that direction.
//
// Today these re-export from `@/lib/install/*`. Phase 2 of the
// FE/BE separation (#753) hoists the canonical definitions into
// `@/contracts` and inverts the import direction.

import { z } from 'zod';

export type { JobState, JobPhase } from '@/lib/install/jobStore';
export type { StackHealth, ChildHealthState } from '@/lib/install/stackHealth';

// ---------------------------------------------------------------------------
// /api/install/status response — Phase 1 worked example (#756). Schema
// is intentionally narrow: only the fields the frontend actually reads
// today. Widening it later is additive. The job sub-shape is lenient
// (passthrough on extra fields) because the canonical JobState lives
// in @/lib/install/jobStore and Phase 2 will hoist it here.
// ---------------------------------------------------------------------------

const JobShapeSchema = z
  .object({
    phase: z.string().optional(),
    startedAt: z.string().optional(),
  })
  .passthrough();

export const InstallStatusResponseSchema = z.object({
  job: JobShapeSchema.nullable(),
  jobIsActive: z.boolean(),
  stackSetupPending: z.boolean(),
  serverStartedAt: z.string(),
  logs: z.string().optional(),
  logsOffset: z.number().optional(),
});

// ---------------------------------------------------------------------------
// POST /api/install/generate-secret — Phase 2 (#759). Returns a fresh
// random secret using the same alphabet/length the install flow has
// used since #19. Optional `length` lets callers override the default
// 32 (currently nothing does, but keeps the schema flexible).
// ---------------------------------------------------------------------------

export const GenerateSecretRequestSchema = z.object({
  length: z.number().int().positive().max(256).optional(),
});

export const GenerateSecretResponseSchema = z.object({
  secret: z.string(),
});

// ---------------------------------------------------------------------------
// POST /api/templates/parse-dependencies — Phase 2 (#759). Reads the
// `servicebay.dependencies` annotation from a raw template.yml and
// returns the dep names. Trivial wrapper over the server-side
// `readManifestAnnotations` so the FE doesn't have to parse YAML.
// ---------------------------------------------------------------------------

export const ParseDependenciesRequestSchema = z.object({
  yaml: z.string(),
});

export const ParseDependenciesResponseSchema = z.object({
  dependencies: z.array(z.string()),
});
