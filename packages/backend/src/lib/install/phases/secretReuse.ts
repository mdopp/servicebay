/**
 * Secret reuse, rotation and the `<redacted>` sentinel guard (#2742 — split
 * out of `runner.ts`).
 *
 * Pure over the install's variable list plus the saved-secret map: no job,
 * no agent, no network. The pre-flight phase calls `reuseSavedSecrets` once
 * before any deploy fires and turns the returned name buckets into the
 * operator-facing lines below (or, for `sentinelUnresolved`, into a hard
 * failure).
 */
import type { JobInputVariable } from '../jobStore';

/**
 * #615 secret-reuse + #2296 sentinel guard, as a pure mutation over the
 * install's variable list. For each `secret | bcrypt | rsa-private` var:
 *
 *   - value === `sentinel` (`<redacted>`): a caller re-sent the read-masked
 *     value. NEVER persist that literal. Swap in the stored real secret if we
 *     have one (→ `sentinelRestored`); otherwise it's unresolvable (→
 *     `sentinelUnresolved`, and the caller must fail the deploy loudly).
 *   - `v.explicit` and a different value was SUPPLIED for this run (#2574):
 *     the supplied value wins and the stored one is left behind (→
 *     `rotatedNames`). Input outranks stored state — without this there was no
 *     supported way to rotate a service password at all: the reuse below
 *     silently put the old one back, the install reported success, and the
 *     only trace was a log line that reads like help.
 *   - otherwise, if a saved secret exists: reuse it (the #615 clean-install
 *     reuse path) and record the override.
 *
 * Mutates `v.value` in place and populates `reusedSecretNames`. Returns the
 * name buckets the caller logs / gates on. A real supplied value with no
 * stored secret is left untouched (normal deploy).
 *
 * The sentinel check stays FIRST and is not weakened by `explicit`: a caller
 * that read the masked value and re-sent `<redacted>` supplied a mask, not a
 * password — "explicitly supplied" cannot mean "deploy the literal mask".
 */
export function reuseSavedSecrets(
  variables: JobInputVariable[],
  saved: Record<string, string>,
  reusedSecretNames: Set<string>,
  sentinel: string,
): {
  overrideNames: string[];
  sentinelRestored: string[];
  sentinelUnresolved: string[];
  rotatedNames: string[];
} {
  const overrideNames: string[] = [];
  const sentinelRestored: string[] = [];
  const sentinelUnresolved: string[] = [];
  const rotatedNames: string[] = [];
  for (const v of variables) {
    // `meta` is `unknown` on the persisted JobInputVariable shape — narrow to
    // the {type} subset we need without reaching for VariableMeta (a UI type).
    const type = (v.meta as { type?: string } | undefined)?.type;
    if (type !== 'secret' && type !== 'bcrypt' && type !== 'rsa-private') continue;
    const stored = saved[v.name];
    if (v.value === sentinel) {
      if (stored) {
        v.value = stored;
        reusedSecretNames.add(v.name);
        sentinelRestored.push(v.name);
      } else {
        sentinelUnresolved.push(v.name);
      }
      continue;
    }
    if (!stored) continue;
    // #2574 — an explicitly supplied value that differs from the stored one is
    // a rotation. Keep it, and do NOT mark the var as reused: the Authelia
    // storage self-heal reads `reusedSecretNames` to decide whether the key
    // matches the on-disk DB, and a rotated key does not.
    if (v.explicit && v.value && v.value !== stored) {
      rotatedNames.push(v.name);
      continue;
    }
    // Track the reuse even when value already matches — downstream self-heals
    // only care whether the value came from saved state.
    reusedSecretNames.add(v.name);
    if (stored === v.value) continue;
    v.value = stored;
    overrideNames.push(v.name);
  }
  return { overrideNames, sentinelRestored, sentinelUnresolved, rotatedNames };
}

/** Render the `name1, name2, +N more` fragment used in the #2296 secret logs. */
export function formatSecretNameList(names: string[], head = 4): string {
  const shown = names.slice(0, head).join(', ');
  return names.length > head ? `${shown}, +${names.length - head} more` : shown;
}

/**
 * #2296 — the operator-facing log line for the "kept the stored secret over a
 * re-sent `<redacted>`" case. Pure so the pluralisation / truncation is tested
 * without driving the whole install loop.
 */
export function formatSentinelRestoredLog(sentinelRestored: string[], sentinel: string): string {
  const n = sentinelRestored.length;
  return `🔒 Ignored the masked value '${sentinel}' sent for ${n} secret variable${n === 1 ? '' : 's'} (${formatSecretNameList(sentinelRestored)}) and kept the previously-stored real secret (#2296).`;
}

/**
 * #2574 — the operator-facing line for a ROTATION: a secret was supplied for
 * this run and differs from the stored one, so the supplied value is what
 * deploys. Says what changed and what the operator must now do (devices /
 * clients still on the old credential will be rejected), because the previous
 * behaviour — silently restoring the old value under a cheerful "Reusing …"
 * line — is exactly what made the rotation look like it had worked.
 */
export function formatSecretRotationLog(rotatedNames: string[]): string {
  const n = rotatedNames.length;
  return `🔁 Applying the ${n === 1 ? 'value you supplied' : 'values you supplied'} for ${n} secret variable${n === 1 ? '' : 's'} (${formatSecretNameList(rotatedNames)}) — ${n === 1 ? 'it replaces the' : 'they replace the'} previously saved ${n === 1 ? 'one' : 'ones'}. Anything still using the old credential will be rejected until you update it (#2574).`;
}

/**
 * #2296 — the hard-fail message when a secret was supplied as the redaction
 * mask and no stored value exists to fall back on. Pure so the copy is
 * asserted in a unit test rather than only through the install loop.
 */
export function buildSentinelUnresolvedError(sentinelUnresolved: string[], sentinel: string): string {
  return `Refusing to deploy: secret variable(s) were supplied as the redaction mask '${sentinel}', not a real value, and no stored secret exists to fall back on: ${sentinelUnresolved.join(', ')}. This usually means a caller read the masked variables and re-sent them verbatim — re-send the real secret value for these vars (#2296).`;
}
