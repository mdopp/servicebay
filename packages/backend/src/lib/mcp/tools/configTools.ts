/**
 * App-config MCP tools (#2384 extraction): a redacted read plus an
 * allow-listed write. Auth/OIDC/SMTP credentials are deliberately out of both.
 */
import { z } from 'zod';
import { getConfig, updateConfig, REDACTED_SENTINEL, type AppConfig } from '@/lib/config';
import { textResult, errorResult, type ToolRegistration } from './context';

/**
 * Secret-shaped key names (#2404).
 *
 * `sanitizeConfig` used to be a three-field denylist (`auth.passwordHash`,
 * `oidc.clientSecret`, `notifications.email.pass`) while `AppConfig`'s whole
 * job includes storing dozens of per-service credentials — so `get_config`
 * handed the LLM `gateway.password`, every entry of `installedSecrets[]`
 * (private keys included), every `installManifest.credentials[]` entry,
 * `lldap.password`, `adguard.password` and `reverseProxy.npm.password` in
 * plaintext. A path denylist is the wrong shape: it can only ever cover the
 * fields someone remembered, and new secret-bearing fields arrive per-service.
 *
 * So the match is on the *key name*, structurally, at every depth. Matching is
 * word-based (`clientSecret` → `client` + `secret`, `LLDAP_ADMIN_PASSWORD` →
 * `lldap` + `admin` + `password`) rather than raw substring, because the
 * config is full of maps keyed by *service name* — `installedTemplates`,
 * `servicePostDeploy`, `serviceMigrations`, `installHandlerFailures`,
 * `templateSettings` — and a raw substring match would redact a service called
 * `keycloak` or `passbolt`. Over-redacting a real field is a bug too, just a
 * far cheaper one than under-redacting, so the tie-breaks below lean redact.
 */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pass', 'passphrase',
  'secret', 'token', 'key', 'apikey', 'privatekey',
  'credential', 'hash', 'salt', 'bearer',
]);

/**
 * Run-together lowercase names never split into words (`apikey`,
 * `clientsecret`, `accesstoken`, `privatekey`), so they get a suffix match on
 * the de-punctuated key as well. Suffix-only, and deliberately without `pass`:
 * a prefix match would catch `keycloak`, and a `pass` suffix would catch
 * `bypass`.
 */
const SECRET_SUFFIXES = [
  'password', 'passphrase', 'secret', 'token', 'key', 'credential', 'hash', 'salt',
];

/** `LLDAP_ADMIN_PASSWORD` / `clientSecret` / `api-key` → lowercase words. */
const splitKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(word => word.toLowerCase())
    .filter(Boolean);

/**
 * Does this key name look like it holds a secret? Exported for the test
 * suite, which pins both the positives and the service-name negatives.
 */
export function isSecretKey(key: string): boolean {
  const words = splitKeyWords(key);
  for (const word of words) {
    if (SECRET_WORDS.has(word)) return true;
    // Plurals: `installedSecrets` → `secrets`, `apiKeys` → `keys`.
    if (word.endsWith('s') && SECRET_WORDS.has(word.slice(0, -1))) return true;
  }
  const flat = words.join('');
  return SECRET_SUFFIXES.some(suffix => flat.endsWith(suffix) || flat.endsWith(`${suffix}s`));
}

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
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? redactValue(val) : scrub(val);
    }
    return out;
  }
  return value;
}

/**
 * Strip secrets before returning config to the LLM (#2404).
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
  server.tool('get_config', 'Read the ServiceBay app config. Every secret-shaped field (password/secret/token/key/hash/credential/…) is redacted at any depth, and secret-bearing collections like installedSecrets and installManifest.credentials are replaced with an entry count.', {}, async () => {
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
