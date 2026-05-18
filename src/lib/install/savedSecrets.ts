/**
 * Secret reuse across installs (#615).
 *
 * The wizard's "secret" / "bcrypt" / "rsa-private" type variables get
 * fresh random values on every install — fine on a brand-new node,
 * catastrophic on a clean-install-with-preserved-data because services
 * like LLDAP only honour `LLDAP_LDAP_USER_PASS` on first DB init.
 *
 * This module:
 *   1. Persists every `type: secret | bcrypt | rsa-private` variable
 *      value at the end of every successful install (`persistInstalledSecrets`).
 *   2. Loads them back on the next install (`loadSavedSecrets`).
 *   3. Falls back to the legacy `config.lldap` / `config.adguard` /
 *      `config.reverseProxy.npm` shapes for installs that predate the
 *      `installedSecrets` field.
 *
 * The override decision (apply or skip) lives in `install/runner.ts` —
 * this module only handles read + write.
 *
 * SECURITY NOTE: each entry's `password` field auto-encrypts at rest
 * via the existing `SENSITIVE_KEYS` regex in config.ts. `varName` is
 * plaintext.
 */
import type { AppConfig } from '@/lib/config';
import { updateConfig } from '@/lib/config';

/** Variable types that hold sensitive material the wizard regenerates. */
const SECRET_TYPES = new Set(['secret', 'bcrypt', 'rsa-private']);

/** Minimal shape this module needs from a variable entry. Deliberately
 *  loose — accepts both the runtime `StackVariable` and the persisted
 *  `JobInputVariable` (whose `meta` is typed `unknown` by design). */
interface VariableLike {
  name: string;
  value: string;
  meta?: unknown;
}

/**
 * Flat lookup `varName → value` of every saved secret. Sources:
 *
 *   1. `config.installedSecrets` — the canonical record, populated by
 *      `persistInstalledSecrets` after every install.
 *   2. Legacy back-compat: the three dedicated fields that pre-date
 *      `installedSecrets` (LLDAP, NPM, AdGuard). Read so the first
 *      install after upgrading still reuses the operator's known
 *      passwords instead of silently regenerating.
 *
 * Layer (1) wins when both are present.
 */
export function loadSavedSecrets(config: AppConfig): Record<string, string> {
  const out: Record<string, string> = {};

  // Legacy back-compat — read first so the canonical map can override.
  if (config.lldap?.password)             out.LLDAP_ADMIN_PASSWORD  = config.lldap.password;
  if (config.reverseProxy?.npm?.password) out.NGINX_ADMIN_PASSWORD  = config.reverseProxy.npm.password;
  if (config.reverseProxy?.npm?.email)    out.NGINX_ADMIN_EMAIL     = config.reverseProxy.npm.email;
  if (config.adguard?.password)           out.ADGUARD_ADMIN_PASSWORD = config.adguard.password;

  // Canonical record (post-#615).
  for (const entry of config.installedSecrets ?? []) {
    if (entry.varName && entry.password) out[entry.varName] = entry.password;
  }
  return out;
}

/**
 * Save every secret-typed variable from a just-completed install. Called
 * at the end of `runJob` after `phase: 'done'` is set. Idempotent in the
 * sense that re-running the same install overwrites with the same values.
 *
 * Merges with whatever is already in `config.installedSecrets` — variables
 * from a previous install for a template that *wasn't* re-deployed this
 * run are preserved. Without that merge, an operator who installs auth
 * first and then later runs an "add Immich" install would lose the LLDAP
 * secret entries from the prior run.
 */
export async function persistInstalledSecrets(
  variables: readonly VariableLike[],
  existing: AppConfig,
): Promise<void> {
  const map = new Map<string, string>();
  for (const entry of existing.installedSecrets ?? []) {
    map.set(entry.varName, entry.password);
  }
  for (const v of variables) {
    const meta = v.meta as { type?: string } | undefined;
    if (!meta?.type || !SECRET_TYPES.has(meta.type)) continue;
    // An empty value would erase a previously-saved secret on re-install
    // — skip rather than clobber. Empty here means the wizard couldn't
    // resolve a value (e.g. RSA endpoint unreachable), not "operator
    // cleared it" — the input shape doesn't carry that distinction.
    if (!v.value) continue;
    map.set(v.name, v.value);
  }
  const list = Array.from(map, ([varName, password]) => ({ varName, password }));
  await updateConfig({ installedSecrets: list });
}
