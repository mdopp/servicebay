/**
 * App-config MCP tools (#2384 extraction): a redacted read plus an
 * allow-listed write. Auth/OIDC/SMTP credentials are deliberately out of both.
 */
import { z } from 'zod';
import { getConfig, updateConfig, REDACTED_SENTINEL, type AppConfig } from '@/lib/config';
// The secret-shaped-key matcher is shared with the MCP audit-log redactor
// (#2624) — one implementation, so a new sink can't ship a fourth copy.
import { isSecretKey } from '../redact';
import { textResult, errorResult, type ToolRegistration } from './context';

/**
 * Keys whose value is raw, unparsed output captured from a script the box ran
 * (#2404 follow-up). Key-name matching alone cannot save these: `stdoutTail` is
 * not a secret-shaped *name*, but its *content* is the last ~1KB of a template's
 * `post-deploy.py` / migration-script stdout — and that stdout is exactly where
 * the wizard's credential-banner protocol emits `__SB_CREDENTIAL__ {json}` lines
 * carrying live passwords, bearer tokens and private keys (see
 * `docs/TEMPLATE_LOGGING.md`). Box-verify confirmed real credentials for several
 * services surviving the key-name scrub inside these strings.
 *
 * Two fields on `AppConfig` are of this class today —
 * `servicePostDeploy[<service>].stdoutTail` and
 * `serviceMigrations[<service>][].stdoutTail` — and both share the same key name,
 * so matching the name covers both plus any future field that persists a tail.
 *
 * Dropped wholesale rather than pattern-scrubbed: the tail is operator-facing
 * diagnostic text surfaced by the dashboard's diagnose page, not something an
 * LLM tool-caller needs to read `logLevel` / `autoUpdate` / proxy hosts. The
 * sibling `lastRunAt` / `exitCode` — the actual "did this service's post-deploy
 * succeed" signal — are non-secret and survive untouched.
 */
const RAW_OUTPUT_KEYS = new Set(['stdouttail']);

const isRawOutputKey = (key: string): boolean => RAW_OUTPUT_KEYS.has(key.toLowerCase());

/**
 * Structural markers that make a *string value* secret-bearing regardless of the
 * key it hangs off. Backstop for the class above: if credential-bearing text
 * reaches some future field this fix has never seen, the marker still catches
 * it. Both are unambiguous — ServiceBay emits the first itself as its
 * credential-capture protocol, and a PEM private-key header is never legitimate
 * config content.
 */
const SECRET_VALUE_MARKERS = ['__SB_CREDENTIAL__', 'PRIVATE KEY-----'];

const hasSecretMarker = (value: string): boolean =>
  SECRET_VALUE_MARKERS.some(marker => value.includes(marker));

/**
 * What a secret-shaped key's value becomes. Objects and arrays are replaced
 * wholesale — that is what strips `installedSecrets[]` and
 * `installManifest.credentials[]`, which an LLM tool-caller never needs (they
 * are operator-facing, via the dashboard's credentials page) — keeping only a
 * count so "there are 35 stored secrets" is still legible.
 *
 * `null` / `undefined` / `''` pass through unchanged: they carry no secret and
 * losing them would destroy the useful "this is not configured" signal.
 */
function redactValue(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (Array.isArray(value)) return `${REDACTED_SENTINEL} (${value.length} entries)`;
  if (typeof value === 'object') return `${REDACTED_SENTINEL} (${Object.keys(value).length} fields)`;
  return REDACTED_SENTINEL;
}

/** Recursive, whole-object scrub. Pure — builds a copy, never mutates. */
function scrub(value: unknown): unknown {
  if (typeof value === 'string' && hasSecretMarker(value)) return REDACTED_SENTINEL;
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSecretKey(key) || isRawOutputKey(key) ? redactValue(val) : scrub(val);
    }
    return out;
  }
  return value;
}

/**
 * Strip secrets before returning config to the LLM (#2404).
 *
 * Three layers, because one is not enough: the key *name* (`isSecretKey`), the
 * key names that hold raw captured script output (`isRawOutputKey`), and the
 * string *value* itself (`hasSecretMarker`). The first pass shipped with only
 * the first layer and box-verify found live credentials still riding out inside
 * `stdoutTail` strings.
 *
 * Read-path only: `update_config`'s allowlist is what governs writes, and it
 * is untouched by this.
 */
export function sanitizeConfig(cfg: AppConfig): Record<string, unknown> {
  return scrub(cfg) as Record<string, unknown>;
}

/**
 * Allowlist: only fields the LLM is allowed to change without explicit user
 * intervention. Auth, OIDC, and notification credentials are deliberately
 * excluded — those need a human in the loop.
 */
const ConfigPatchSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  serverName: z.string().max(64).optional(),
  domain: z.string().max(255).optional(),
  autoUpdate: z.object({
    enabled: z.boolean().optional(),
    schedule: z.string().optional(),
  }).partial().optional(),
  templateSettings: z.record(z.string(), z.string()).optional(),
}).strict();

export function registerConfigTools({ server }: ToolRegistration) {
  server.tool('get_config', 'Read the ServiceBay app config. Every secret-shaped field (password/secret/token/key/hash/credential/…) is redacted at any depth, secret-bearing collections like installedSecrets and installManifest.credentials are replaced with an entry count, and captured script output (servicePostDeploy/serviceMigrations stdoutTail) is withheld because it embeds credential banners — lastRunAt/exitCode still show whether a post-deploy run succeeded.', {}, async () => {
    const config = await getConfig();
    return textResult(sanitizeConfig(config));
  });

  server.tool(
    'update_config',
    'Update select ServiceBay config fields. Allowed: logLevel, serverName, domain, autoUpdate, templateSettings. Auth/OIDC/SMTP are intentionally excluded.',
    { patch: ConfigPatchSchema.describe('Partial config to merge') },
    async ({ patch }) => {
      try {
        const current = await getConfig();
        const merged: Partial<AppConfig> = {};
        if (patch.logLevel !== undefined) merged.logLevel = patch.logLevel;
        if (patch.serverName !== undefined) merged.serverName = patch.serverName;
        if (patch.domain !== undefined) merged.domain = patch.domain;
        if (patch.templateSettings !== undefined) merged.templateSettings = patch.templateSettings;
        if (patch.autoUpdate) {
          merged.autoUpdate = { ...current.autoUpdate, ...patch.autoUpdate };
        }
        const updated = await updateConfig(merged);
        return textResult({ ok: true, config: sanitizeConfig(updated) });
      } catch (err) {
        return errorResult(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
