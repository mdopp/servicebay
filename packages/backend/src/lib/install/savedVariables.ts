/**
 * The per-service record of what an install actually deployed, and the
 * operator-set values it hands back to the next one (#2531, #2785).
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
 * ## Two questions, one store (#2785)
 *
 * #2531 answered "which value must the next install reuse?" by storing only
 * the DIFF from the template default. That store cannot answer the other
 * question — "what is this service installed WITH?" — and a box proved it:
 * `installedVariables` held three box-wide entries and nothing per-service,
 * so an unattended redeploy of a multi-variable stack had nothing to
 * converge on and silently re-derived every setting (ADR 0012: a reconciler
 * cannot converge on values it never stored). Two things were losing
 * per-service values:
 *
 *   1. A value the CALLER supplied for the run — `install_template({variables})`
 *      via `prefilled` — is flagged `global` by the assembler, and every
 *      `global` was skipped as "re-derives from config anyway". For a
 *      caller-supplied value that is exactly wrong: it re-derives from
 *      nothing, so it was dropped on the floor. `explicit` (#2574) is the
 *      assembler's own marker for that case, and it now overrides the skip.
 *   2. A value that merely EQUALS the template default was not recorded at
 *      all, so nothing on the box knew the service had been deployed with it.
 *
 * So: **the RECORD is complete, the REUSE is narrow.** Every per-service
 * variable of the run is recorded — with the `default` in force when it was
 * written, and with secrets as references — while {@link loadSavedVariables},
 * the map the install path reuses, still yields only values that DIFFER from
 * that default. That keeps the #1297 contract intact (a template bumping a
 * default still reaches a box that never overrode it) while giving
 * `get_service_files` and any future reconciler the full picture.
 *
 * SECURITY NOTE: recorded values are stored in plaintext, deliberately —
 * these are the variables the template declares as non-secret, and the same
 * values already sit in plaintext in `config.templateSettings` and in the
 * pod YAML on disk. A `type: secret | bcrypt | rsa-private` variable is
 * recorded as a `kind: 'secret'` REFERENCE with an EMPTY value: the value
 * itself only ever lives in `installedSecrets` (encrypted at rest via the
 * config `SENSITIVE_KEYS` regex), which `savedSecrets.ts` owns.
 */
import type { AppConfig, InstalledVariableRecord } from '@/lib/config';
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
  /** #2574 — the caller supplied this value for THIS run. */
  explicit?: boolean;
  meta?: unknown;
}

/** The fields this module reads off a variable's `meta`. */
interface MetaLike {
  type?: string;
  default?: string;
  templateName?: string;
}

const metaOf = (v: VariableLike): MetaLike | undefined => v.meta as MetaLike | undefined;

/** Flat lookup `varName → value` of every saved operator-set variable.
 *
 *  Only the entries that DIFFER from the template default recorded with them
 *  are returned: the store is a complete per-service record (#2785), but a
 *  value that is merely what the template ships must not be handed back as an
 *  override, or a template could never bump a default again (#1297).
 *
 *  Takes only the field it reads so read-only consumers can call it with a
 *  narrower config view (see `lib/template/effectiveVariables.ts`); an
 *  `AppConfig` still satisfies it. */
export function loadSavedVariables(config: Pick<AppConfig, 'installedVariables'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of config.installedVariables ?? []) {
    if (!entry.varName) continue;
    // Re-uses the write-side predicate so "what counts as operator-set" is
    // decided in exactly one place, on the way in and on the way out.
    if (!isOperatorSetVariable(recordAsVariable(entry))) continue;
    out[entry.varName] = entry.value;
  }
  return out;
}

/** Every recorded variable of one service, in record order (#2785). The
 *  readback surface — `get_service_files` shows an operator what the service
 *  is installed with, secrets named but never valued. */
export function loadServiceVariables(
  config: Pick<AppConfig, 'installedVariables'>,
  service: string,
): InstalledVariableRecord[] {
  return (config.installedVariables ?? []).filter(e => e.service === service);
}

/** A stored record, in the shape {@link isOperatorSetVariable} reads. */
function recordAsVariable(entry: InstalledVariableRecord): VariableLike {
  return {
    name: entry.varName,
    value: entry.value,
    meta: { type: entry.kind, default: entry.default },
  };
}

/**
 * Is this variable's value one the next install should REUSE?
 *
 * No for a box-wide `global` (PUBLIC_DOMAIN, LLDAP_HOST, …) — those re-derive
 * from config on every assemble, so a saved copy could only go stale. The one
 * exception is a global the caller supplied for this run (`explicit`, #2574):
 * `install_template({variables})` marks its values global, and those re-derive
 * from nothing at all, so skipping them is how an unattended redeploy lost
 * every value the caller had chosen (#2785). No for a secret type —
 * `savedSecrets` owns those. No for an empty value, and no for a value that is
 * just the template's own default.
 *
 * A variable with no `meta` (a manifest saved before metadata travelled
 * with it) is treated as having an empty default, i.e. any non-empty value
 * counts as operator-set. That errs toward PRESERVING the operator's value,
 * which is the direction this bug is about.
 */
export function isOperatorSetVariable(v: VariableLike): boolean {
  if (!isPerServiceVariable(v)) return false;
  const meta = metaOf(v);
  if (meta?.type && SECRET_TYPES.has(meta.type)) return false;
  if (!v.value) return false;
  return v.value !== (meta?.default ?? '');
}

/**
 * Is this variable part of a SERVICE's variable set, as opposed to box-wide
 * state that re-derives from config on every assemble?
 *
 * Wider than {@link isOperatorSetVariable} on purpose: this is what gets
 * RECORDED (#2785), including secrets-by-reference and values that happen to
 * equal the template default.
 */
function isPerServiceVariable(v: VariableLike): boolean {
  return !v.global || !!v.explicit;
}

/** The record to store for one variable of a completed run. */
function toRecord(v: VariableLike, previous?: InstalledVariableRecord): InstalledVariableRecord {
  const meta = metaOf(v);
  const isSecret = !!meta?.type && SECRET_TYPES.has(meta.type);
  // A replayed manifest can carry a variable with no `meta` at all (the
  // slot-fill in `applyVariableDefaults` appends bare name/value pairs), so
  // carry the previous record's attribution forward rather than degrading a
  // per-service record into an anonymous one on every reinstall.
  const service = meta?.templateName && meta.templateName !== 'global' ? meta.templateName : previous?.service;
  // Same carry-forward for the default: what the current run knows wins, what
  // it doesn't know is kept rather than dropped.
  const declaredDefault = meta?.default ?? previous?.default;
  return {
    varName: v.name,
    // Never the credential itself — `installedSecrets` holds that.
    value: isSecret ? '' : v.value,
    ...(service ? { service } : {}),
    ...(!isSecret && declaredDefault !== undefined ? { default: declaredDefault } : {}),
    ...(isSecret ? { kind: 'secret' as const } : {}),
  };
}

/**
 * The next `installedVariables` list after an install. Pure, so the
 * upsert/remove rules are testable without touching config.
 *
 * Variables NOT in this run are left alone — installing `immich` must not
 * forget what the operator set on `auth` (same merge rule as
 * `persistInstalledSecrets`). Variables that ARE in this run are rewritten:
 * recorded when they belong to a service and deployed with a value, removed
 * otherwise (a cleared value, or a variable that became box-wide global) — so
 * the store never resurrects a value the operator deliberately dropped.
 */
export function computeInstalledVariables(
  variables: readonly VariableLike[],
  existing: AppConfig,
): InstalledVariableRecord[] {
  const map = new Map<string, InstalledVariableRecord>();
  for (const entry of existing.installedVariables ?? []) {
    map.set(entry.varName, entry);
  }
  for (const v of variables) {
    if (!isPerServiceVariable(v) || !v.value) {
      map.delete(v.name);
      continue;
    }
    map.set(v.name, toRecord(v, map.get(v.name)));
  }
  return Array.from(map.values());
}

/**
 * Save the per-service variable record from a just-completed install. Called
 * at the end of `runJob` after `phase: 'done'`, next to
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
