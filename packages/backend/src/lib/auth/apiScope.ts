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
 */
export type ApiScope = 'read' | 'lifecycle' | 'mutate' | 'reboot' | 'destroy' | 'exec';
export const ALL_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate', 'reboot', 'destroy', 'exec'];
