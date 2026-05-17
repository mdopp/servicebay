/**
 * Zod schema for AppConfig (#595).
 *
 * Mirrors the `AppConfig` interface in `../config.ts` at the top level
 * so that POST /api/settings can reject typos (e.g. `servername` vs
 * `serverName`) and obviously-wrong types BEFORE they get persisted.
 *
 * Strategy — strict-top, loose-inside:
 *   - Top-level `.strict()` rejects unknown keys (the issue's main win).
 *   - Simple primitives (`serverName`, `domain`, `logLevel`, …) get
 *     proper types so typo'd values surface as 400.
 *   - Complex nested objects (`gateway`, `reverseProxy`, `mcp`,
 *     `notifications`, etc.) use `.passthrough()` for now so the
 *     schema doesn't need to recapitulate every nested TS interface
 *     in one go. Tightening those is purely additive — narrow them
 *     case by case as bugs surface.
 *
 * The schema is exported so the UI form can pre-validate client-side
 * with the same shape (deferred for now; the server-side gate is the
 * security boundary).
 */

import { z } from 'zod';

const LOG_LEVEL = z.enum(['debug', 'info', 'warn', 'error']);

/** Loose object pass-through for the complex nested fields we haven't
 *  schematized yet. Keeps the top-level rejection in force without
 *  re-implementing every TS interface in Zod. */
const looseObject = z.object({}).passthrough();
const looseArray = z.array(z.unknown());

const AppConfigSchema = z.object({
  // ── primitives (tight) ─────────────────────────────────────────────
  logLevel: LOG_LEVEL.optional(),
  serverName: z.string().max(120).optional(),
  domain: z.string().max(255).optional(),
  setupCompleted: z.boolean().optional(),
  stackSetupPending: z.boolean().optional(),

  // ── complex objects (loose, tighten incrementally) ─────────────────
  gateway: looseObject.optional(),
  reverseProxy: looseObject.optional(),
  agent: looseObject.optional(),
  templateSettings: z.record(z.string(), z.string()).optional(),
  autoUpdate: z.object({
    enabled: z.boolean(),
    schedule: z.string(),
    lastNotifiedVersion: z.string().optional(),
  }).passthrough().optional(),
  updateWindow: looseObject.optional(),
  registries: looseObject.optional(),
  externalLinks: looseArray.optional(),
  mcp: z.object({
    allowMutations: z.boolean().optional(),
    allowDangerousExec: z.boolean().optional(),
  }).passthrough().optional(),
  notifications: looseObject.optional(),
  auth: looseObject.optional(),
  oidc: looseObject.optional(),
  backup: looseObject.optional(),
  lldap: looseObject.optional(),
  adguard: looseObject.optional(),
  reinstall: looseObject.optional(),
  servicePostDeploy: z.record(z.string(), looseObject).optional(),
  installedTemplates: z.record(z.string(), looseObject).optional(),
  serviceMigrations: z.record(z.string(), looseArray).optional(),
  installManifest: looseObject.optional(),
  accessRequests: looseArray.optional(),
}).strict();

/**
 * Partial schema for PATCH-style merges where only a subset of fields
 * is sent (the common case for the settings UI's "save section"
 * buttons). `.strict()` still rejects unknown keys; required fields
 * inside the nested loose objects are not enforced here either.
 */
export const AppConfigPartialSchema = AppConfigSchema.partial();

/** Format a Zod issue tree as a flat, human-readable error array. */
export function formatConfigErrors(error: z.ZodError): string[] {
  return error.issues.map(i => {
    const path = i.path.length > 0 ? i.path.join('.') : '<root>';
    return `${path}: ${i.message}`;
  });
}
