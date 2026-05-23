/**
 * Centralized reset validation engine (#847 / ARCH-16a).
 *
 * Before a clean-install wipe runs, `validateResetCombo` checks the
 * operator-selected preserve/wipe groups for unsafe combinations.
 *
 * Static rules:
 *   - Wiping `secrets` while preserving `certs` is invalid: NPM's API
 *     credentials live under secrets; without them the cert DB rows
 *     reference unreachable keys.
 *   - Wiping `secrets` while preserving `identity` is invalid:
 *     Authelia/LLDAP's encryption keys are under secrets.
 *
 * Dynamic rules (selfHeal contracts — ARCH-17):
 *   - If a stack template declares `selfHeal: { <template>: 'none' }`,
 *     wiping secrets without also wiping the template's data group
 *     leaves the template in a broken state that ServiceBay cannot
 *     automatically recover from.
 */
import { RESET_GROUPS, type ResetGroup } from './resetGroups';
import { loadStackManifestsWithSelfHeal } from '../template/stackContract';

export interface ResetComboValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Map template names to their owning reset group.
 * `nginx` → `certs`, `auth` → `identity`, everything else → `service-data`.
 */
function templateToResetGroup(templateName: string): ResetGroup {
  switch (templateName) {
    case 'nginx': return 'certs';
    case 'auth':  return 'identity';
    default:      return 'service-data';
  }
}

/**
 * Validate whether the given preserve combination is safe.
 *
 * @param options.preserve - Groups the operator wants to keep.
 * @param options.node     - Target node (unused today, reserved for multi-node).
 */
export async function validateResetCombo(options: {
  preserve: string[];
  node?: string;
}): Promise<ResetComboValidationResult> {
  const errors: string[] = [];
  const preserve = new Set(options.preserve);
  const validGroups = new Set(Object.keys(RESET_GROUPS));

  // Silently ignore unknown groups (forward-compat).
  const effectivePreserve = new Set(
    [...preserve].filter(g => validGroups.has(g)),
  );

  const willWipeSecrets = !effectivePreserve.has('secrets');

  // --- Static rules ---

  if (willWipeSecrets && effectivePreserve.has('certs')) {
    errors.push(
      'Cannot preserve certificates while wiping secrets. ' +
      'NPM\'s API credentials live under secrets — without them, ' +
      'the certificate database becomes unreadable. ' +
      'Either preserve secrets or also wipe certificates.',
    );
  }

  if (willWipeSecrets && effectivePreserve.has('identity')) {
    errors.push(
      'Cannot preserve identity (Authelia + LLDAP) while wiping secrets. ' +
      'The identity provider\'s encryption keys live under secrets — ' +
      'without them, user accounts and OIDC clients become inaccessible. ' +
      'Either preserve secrets or also wipe identity.',
    );
  }

  // --- Dynamic rules (selfHeal contracts) ---
  if (willWipeSecrets) {
    try {
      const stacks = await loadStackManifestsWithSelfHeal();
      for (const stack of stacks) {
        if (!stack.selfHeal) continue;
        for (const [templateName, healMode] of Object.entries(stack.selfHeal)) {
          if (healMode !== 'none') continue;
          const targetGroup = templateToResetGroup(templateName);
          if (effectivePreserve.has(targetGroup)) {
            errors.push(
              `Cannot preserve "${targetGroup}" while wiping secrets: ` +
              `template "${templateName}" (stack "${stack.name}") declares ` +
              `selfHeal: none — its data cannot be recovered without the ` +
              `original encryption keys. Either preserve secrets or also ` +
              `wipe "${targetGroup}".`,
            );
          }
        }
      }
    } catch {
      // If stack manifests can't be loaded, skip dynamic rules.
      // Static rules still protect against the most dangerous combos.
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
