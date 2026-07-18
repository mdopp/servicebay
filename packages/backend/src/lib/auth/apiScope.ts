/**
 * MCP API scope discriminator (#601 cycle-break).
 *
 * Extracted leaf so `tokens.ts` and `bootstrapToken.ts` can both
 * import the shared type without forming a cycle. Both modules used
 * to reach for it from `tokens.ts`, then `tokens.ts` dynamically
 * imported `bootstrapToken.ts` to revoke the bootstrap on first
 * named-token mint — closing the loop. After #601 the revoke call
 * moves into the API route, this file is the single source of truth
 * for the type, and the cycle is gone.
 */

/**
 * Risk tiers, least→most destructive:
 *   read      lookups + diagnose + log readers
 *   lifecycle start/stop/restart + run_check_now + refresh + run_backup
 *   mutate    create/update/add + config writes — additive changes
 *   reboot    reboot_node — transient & recoverable host restart (#1765);
 *             split out of `destroy` so a token can grant operate+reboot
 *             WITHOUT also granting irreversible delete/wipe. `destroy`
 *             implies `reboot` (see tokenHasScope).
 *   destroy   delete/restore/purge/factory_reset — irreversible state edits
 *   exec      exec_command — shell access
 *   propose   submit a learning proposal (#2326) — an INDEPENDENT, low-privilege
 *             capability scope, NOT part of the read<…<exec blast-radius ladder.
 *             A `propose` token may submit knowledge proposals and NOTHING else;
 *             read/mutate/destroy/etc. do NOT imply it, and it implies nothing.
 *             Grant it alone (least-privilege) or alongside other scopes.
 */
export type ApiScope = 'read' | 'lifecycle' | 'mutate' | 'reboot' | 'destroy' | 'exec' | 'propose';
export const ALL_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate', 'reboot', 'destroy', 'exec', 'propose'];

/**
 * Whether a held scope set satisfies a single `required` scope, honoring the
 * implication rules carved out of the original `destroy` tier:
 *   - `destroy` implies `exec`  (the pre-#591 exec-via-destroy back-compat)
 *   - `destroy` implies `reboot` (#1765 — reboot split out of destroy)
 *
 * Single source of truth for scope implication. `mcp/server.ts`'s
 * `tokenHasScope` and the delegated-mint subset check (#2048) both route
 * through this so the ladder stays consistent in one place.
 */
export function scopeSatisfiedBy(held: readonly ApiScope[], required: ApiScope): boolean {
  if (held.includes(required)) return true;
  if (required === 'exec' && held.includes('destroy')) return true;
  if (required === 'reboot' && held.includes('destroy')) return true;
  return false;
}

/**
 * Whether `child` is a (possibly implied) subset of `parent` — every scope the
 * child wants is held, directly or by implication, by the parent. Used to gate
 * delegated child-token minting (#2048): a parent with `destroy` may mint a
 * child with `reboot`/`exec`, but a child may never widen beyond its parent.
 */
export function scopesAreSubset(child: readonly ApiScope[], parent: readonly ApiScope[]): boolean {
  return child.every(s => scopeSatisfiedBy(parent, s));
}
