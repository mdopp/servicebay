/**
 * Operator-set NON-secret variable reuse across installs (#2531).
 *
 * `savedSecrets.ts` persists `secret | bcrypt | rsa-private` values so a
 * reinstall keeps the password a service was initialised with. Everything
 * else — every `text`, `select`, `subdomain`, … variable — had no such
 * memory: `assembleManifest` rebuilds the variable set from
 * `variables.json` defaults on every run, so a value an operator typed by
 * hand and that has no default to fall back on came back EMPTY, silently.
 * The reported case blanked a Web Push VAPID public key on a plain
 * reinstall with no overrides: no error, no warning, the feature just
 * stopped working. Templates worked around it one variable at a time with
 * bespoke post-deploy re-stamps; anything the author forgot was lost.
 *
 * What is stored: only values the OPERATOR set — a value that is non-empty
 * AND differs from the template default in force when it was saved. That
 * distinction is what keeps this from freezing the box on old defaults: a
 * variable the operator never touched carries no record, so a template
 * bumping its default still reaches the box (the #1297 contract). A
 * variable that stops being operator-set (cleared, or edited back to the
 * default) has its record REMOVED, so the store never resurrects a value
 * the operator deliberately dropped.
 *
 * SECURITY NOTE: values are stored in plaintext, deliberately — these are
 * the variables the template declares as non-secret, and the same values
 * already sit in plaintext in `config.templateSettings` and in the pod
 * YAML on disk. Anything sensitive belongs in a `type: secret` variable,
 * which this module skips entirely (`savedSecrets` owns those, encrypted
 * at rest via the config `SENSITIVE_KEYS` regex).
 */
import type { AppConfig } from '@/lib/config';
import { updateConfig } from '@/lib/config';

/** Handled by `savedSecrets.ts` — never duplicated in plaintext here. */
const SECRET_TYPES = new Set(['secret', 'bcrypt', 'rsa-private']);

/** Minimal shape this module needs. Deliberately loose — accepts both the
 *  runtime `StackVariable` and the persisted `JobInputVariable` (whose
 *  `meta` is typed `unknown` by design). */
interface VariableLike {
  name: string;
  value: string;
  global?: boolean;
  meta?: unknown;
}

/** Flat lookup `varName → value` of every saved operator-set variable. */
export function loadSavedVariables(config: AppConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of config.installedVariables ?? []) {
    if (entry.varName && entry.value) out[entry.varName] = entry.value;
  }
  return out;
}

/**
 * Is this variable an operator-set value worth remembering?
 *
 * No for a `global` (PUBLIC_DOMAIN, LLDAP_HOST, …) — those re-derive from
 * config on every assemble, so a saved copy could only go stale. No for a
 * secret type — `savedSecrets` owns those. No for an empty value, and no
 * for a value that is just the template's own default.
 *
 * A variable with no `meta` (a manifest saved before metadata travelled
 * with it) is treated as having an empty default, i.e. any non-empty value
 * counts as operator-set. That errs toward PRESERVING the operator's value,
 * which is the direction this bug is about.
 */
export function isOperatorSetVariable(v: VariableLike): boolean {
  if (v.global) return false;
  const meta = v.meta as { type?: string; default?: string } | undefined;
  if (meta?.type && SECRET_TYPES.has(meta.type)) return false;
  if (!v.value) return false;
  return v.value !== (meta?.default ?? '');
}

/**
 * The next `installedVariables` list after an install. Pure, so the
 * upsert/remove rules are testable without touching config.
 *
 * Variables NOT in this run are left alone — installing `immich` must not
 * forget what the operator set on `auth` (same merge rule as
 * `persistInstalledSecrets`). Variables that ARE in this run are rewritten:
 * upserted when operator-set, removed otherwise.
 */
export function computeInstalledVariables(
  variables: readonly VariableLike[],
  existing: AppConfig,
): Array<{ varName: string; value: string }> {
  const map = new Map<string, string>();
  for (const entry of existing.installedVariables ?? []) {
    map.set(entry.varName, entry.value);
  }
  for (const v of variables) {
    if (isOperatorSetVariable(v)) map.set(v.name, v.value);
    else map.delete(v.name);
  }
  return Array.from(map, ([varName, value]) => ({ varName, value }));
}

/**
 * Save the operator-set variables from a just-completed install. Called at
 * the end of `runJob` after `phase: 'done'`, next to
 * `persistInstalledSecrets` and for the same reason: only a successful run
 * describes the box's real configuration.
 */
export async function persistInstalledVariables(
  variables: readonly VariableLike[],
  existing: AppConfig,
): Promise<void> {
  await updateConfig({ installedVariables: computeInstalledVariables(variables, existing) });
}

/**
 * The loud backstop. Names of variables that HAD an operator-set value on a
 * previous install and are nevertheless about to deploy empty.
 *
 * With the reuse above this should be unreachable, which is the point: it
 * is not a fallback that quietly substitutes something, it is the condition
 * under which a value is genuinely lost. The runner logs it as its own
 * distinct line rather than folding it into the generic "#1318 rendered
 * empty" warning — "this variable is unset" and "the value you set is GONE"
 * are different operator problems, and the second one is the destructive one.
 */
export function findUnrecoveredVariables(
  variables: readonly VariableLike[],
  saved: Record<string, string>,
): string[] {
  return variables.filter(v => !v.value && saved[v.name]).map(v => v.name);
}

/**
 * The operator-facing line for {@link findUnrecoveredVariables}. Deliberately
 * says the value is GONE and what to do about it — the generic "rendered
 * empty" warning reads as "you may not have filled this in", which is the
 * wrong story when the value existed and we lost it.
 */
export function buildUnrecoveredVariablesWarning(names: string[]): string {
  const list = names.join(', ');
  const plural = names.length === 1 ? 'a value' : 'values';
  return `❗ Lost operator-set ${plural}: ${list} — ${names.length === 1 ? 'this variable was' : 'these variables were'} set on a previous install but could not be recovered for this one, so ${names.length === 1 ? 'it deploys' : 'they deploy'} EMPTY. Re-enter ${names.length === 1 ? 'it' : 'them'} in Configure before the pod is relied on; nothing will substitute a default for you.`;
}
