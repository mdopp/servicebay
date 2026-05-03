import { z } from 'zod';

/**
 * Top-level shape validation for `DigitalTwinStore.updateNode()` payloads.
 *
 * We validate only the *kind* of each top-level key (array vs object) — not
 * the deep contents, since the agent already shapes those before pushing and
 * full validation here would duplicate the agent's contract. This keeps the
 * store as the single funnel for invariants without over-coupling it to
 * the inner type evolution of EnrichedContainer / ServiceUnit.
 */
export const NodeTwinUpdateSchema = z.object({
  connected: z.boolean().optional(),
  lastSync: z.number().optional(),
  initialSyncComplete: z.boolean().optional(),
  resources: z.unknown().optional(),
  containers: z.array(z.unknown()).optional(),
  services: z.array(z.unknown()).optional(),
  volumes: z.array(z.unknown()).optional(),
  files: z.record(z.string(), z.unknown()).optional(),
  proxy: z.array(z.unknown()).optional(),
  health: z.unknown().optional(),
  nodeIPs: z.array(z.string()).optional(),
  unmanagedBundles: z.array(z.unknown()).optional(),
  dismissedBundles: z.array(z.string()).optional(),
  history: z.array(z.unknown()).optional(),
}).passthrough();
