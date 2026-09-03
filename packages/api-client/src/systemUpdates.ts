// Host OS package-update contract — #2745.
//
// Replaced `getSystemUpdates` from
// `packages/frontend/src/app/actions/system.ts`. Distinct from
// `/api/system/update`, which is the ServiceBay *self*-updater: this one
// counts pending apt packages on the host.

import { z } from 'zod';
import { callApi } from './client';

export const SystemUpdatesSchema = z.object({
  count: z.number(),
  list: z.array(z.string()),
});
export type SystemUpdates = z.infer<typeof SystemUpdatesSchema>;

/** GET /api/system/os-updates — remote nodes always report zero. */
export function getSystemUpdates(nodeName?: string) {
  const query = nodeName ? `?node=${encodeURIComponent(nodeName)}` : '';
  return callApi(`/api/system/os-updates${query}`, SystemUpdatesSchema);
}
