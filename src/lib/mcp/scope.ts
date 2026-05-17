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

export type ApiScope = 'read' | 'lifecycle' | 'mutate' | 'destroy' | 'exec';
export const ALL_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate', 'destroy', 'exec'];
