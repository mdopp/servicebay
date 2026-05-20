/**
 * Shared stack-install types (#601 cycle-break).
 *
 * Extracted leaf so `credentialsManifest.ts` and `postInstall.ts` can
 * both import the `StackVariable` shape without forming a cycle.
 * Before: postInstall.ts owned the type, credentialsManifest reached
 * for it → 2-node cycle that depcruise flagged.
 */

import type { VariableMeta } from '../registry';

export interface StackVariable {
  name: string;
  value: string;
  global?: boolean;
  meta?: VariableMeta;
}
