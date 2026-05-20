/**
 * Secret reuse across installs (#615, extended in #622).
 *
 * The wizard's "secret" / "bcrypt" / "rsa-private" type variables get
 * fresh random values on every install — fine on a brand-new node,
 * catastrophic on a clean-install-with-preserved-data because services
 * like LLDAP only honour `LLDAP_LDAP_USER_PASS` on first DB init.
 *
 * This module:
 *   1. Persists each secret-typed variable **at first generation**, before
 *      any unit deploys (`persistSingleSecret`, called from the wizard's
 *      Configure step). #622 — was previously post-success in #615, which
 *      meant a mid-install failure lost the secrets the next retry needed.
 *   2. Still runs an end-of-run persist (`persistInstalledSecrets`) as a
 *      safety net for variables the wizard didn't generate explicitly
 *      (e.g. operator-typed values).
 *   3. Loads saved secrets back on the next install (`loadSavedSecrets`).
 *   4. Falls back to the legacy `config.lldap` / `config.adguard` /
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
import { getConfig, updateConfig } from '@/lib/config';

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

/**
 * Per-process queue for single-secret upserts. `updateConfig` already
 * serializes its own read-modify-write across the config file, but the
 * "append a single entry to an array field" pattern needs an outer lock:
 * deepMerge replaces arrays wholesale, so two concurrent callers each
 * reading the current list, computing `list + [their entry]`, and writing
 * back would lose one of the two entries. Serializing here closes that
 * window for all callers that go through `persistSingleSecret`.
 */
let singleSecretQueue: Promise<unknown> = Promise.resolve();
function withSingleSecretLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = singleSecretQueue.then(fn, fn);
  singleSecretQueue = next.catch(() => undefined);
  return next;
}

/**
 * Upsert one secret-typed variable into `config.installedSecrets` atomically.
 * Called from the wizard's Configure step the moment a value is generated,
 * so a mid-install failure can never strand the operator with secrets that
 * exist only in browser state.
 *
 * No-ops if the entry already exists with the same value (idempotent), or
 * if either argument is empty (an empty value must never clobber a saved
 * one — see persistInstalledSecrets for the same rule).
 *
 * Returns `true` if it wrote, `false` if it was already up-to-date.
 */
export async function persistSingleSecret(varName: string, value: string): Promise<boolean> {
  if (!varName || !value) return false;
  return withSingleSecretLock(async () => {
    const current = await getConfig();
    const existing = current.installedSecrets ?? [];
    const idx = existing.findIndex(e => e.varName === varName);
    if (idx >= 0 && existing[idx].password === value) return false;
    const next = idx >= 0
      ? existing.map((e, i) => (i === idx ? { varName, password: value } : e))
      : [...existing, { varName, password: value }];
    await updateConfig({ installedSecrets: next });
    return true;
  });
}
