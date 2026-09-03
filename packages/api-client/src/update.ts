// ServiceBay self-updater contracts — GET/POST /api/system/update
// (sb/no-raw-api-fetch sweep, #603 migration predates the api-client). This
// is the app's OWN self-updater, distinct from `systemUpdates.ts` (host OS
// package updates counted by `/api/system/os-updates`) and `install.ts`
// (stack/template install pipeline).
//
// The route shapes its own `NextResponse.json(...)` body directly — none of
// it goes through `withApiHandler`'s `{ ok, data }` auto-envelope — so
// rawApi/mutateRawApi throughout.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';

const AutoUpdateConfigSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string(),
});

/**
 * Mirrors `AppUpdateStatus` (formerly local to `ServiceBayUpdateCard.tsx`,
 * #2082). `running`/`unreleasedBuild`/`imageBuilding` are lenient/optional —
 * older config states and a `:dev`/`:test` box legitimately omit them
 * (#2708, #2493).
 */
export const AppUpdateStatusSchema = z
  .object({
    hasUpdate: z.boolean(),
    current: z.string(),
    imageBuilding: z.boolean().optional(),
    latest: z
      .object({
        version: z.string(),
        url: z.string(),
        date: z.string(),
        notes: z.string(),
      })
      .nullable(),
    running: z
      .object({
        channel: z.string().nullable().optional(),
        revision: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    unreleasedBuild: z.boolean().optional(),
    config: z.object({ autoUpdate: AutoUpdateConfigSchema }).passthrough(),
  })
  .passthrough();
export type AppUpdateStatus = z.infer<typeof AppUpdateStatusSchema>;

/** GET /api/system/update */
export function fetchAppUpdateStatus() {
  return rawApi('/api/system/update', AppUpdateStatusSchema);
}

const UpdateActionResponseSchema = z
  .object({
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough();

/** POST /api/system/update — action: 'update'. Server restarts on success,
 *  so the response may not always reach the client. */
export function triggerAppUpdate(version: string) {
  return mutateRawApi('/api/system/update', UpdateActionResponseSchema, { action: 'update', version });
}

const ConfigureAutoUpdateResponseSchema = z
  .object({
    success: z.boolean().optional(),
    config: z.object({ autoUpdate: AutoUpdateConfigSchema }).passthrough(),
  })
  .passthrough();

/** POST /api/system/update — action: 'configure'. */
export function configureAutoUpdate(enabled: boolean) {
  return mutateRawApi('/api/system/update', ConfigureAutoUpdateResponseSchema, {
    action: 'configure',
    autoUpdate: { enabled },
  });
}
