import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listProfiles, saveProfile, deleteProfile } from '@/lib/diskImport/profiles';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import type { Rule } from '@servicebay/disk-import-worker';

export const dynamic = 'force-dynamic';

/** A single folder's explicit (partial) routing rule — every axis optional. Values
 *  are re-validated by the apply/replan body before they ever form a path. */
const ruleSchema = z
  .object({
    disposition: z.string().optional(),
    mode: z.enum(['merge', 'parallel']).optional(),
    owner: z.string().optional(),
  })
  .strict();

/** Save body: a named selection (the explicit rule map + optional disk default). */
const saveSchema = z
  .object({
    name: z.string().min(1).max(80),
    rules: z.record(z.string(), ruleSchema).default({}),
    rootDefault: ruleSchema.optional(),
  })
  .strict();

const deleteQuery = z.object({ name: z.string().min(1) });

/**
 * GET — list saved routing presets (#2007), newest first. Presets persist the
 * operator's per-folder owner/target selection so a fresh scan of the same disk can
 * re-load it and go straight to "Re-plan & import" with zero re-entry.
 */
export const GET = withApiHandler(
  { tokenScope: 'mutate' },
  async () => {
    try {
      return NextResponse.json({ ok: true, profiles: await listProfiles() });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:profiles:list', status: 400, exposeMessage: true });
    }
  },
);

/** POST — save (create or overwrite) a named preset from the page's current picks. */
export const POST = withApiHandler<z.infer<typeof saveSchema>>(
  { tokenScope: 'mutate', body: saveSchema },
  async ({ body }) => {
    try {
      // The zod schema validates values at runtime; the cast narrows the inferred
      // `string` disposition to the engine's literal union (mirrors replanBody).
      const profile = await saveProfile({
        name: body.name,
        rules: body.rules as Record<string, Rule>,
        rootDefault: body.rootDefault as Partial<Rule> | undefined,
      });
      return NextResponse.json({ ok: true, profile });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:profiles:save', status: 400, exposeMessage: true });
    }
  },
);

/** DELETE — remove a preset by `?name=` (idempotent). */
export const DELETE = withApiHandler<undefined, z.infer<typeof deleteQuery>>(
  { tokenScope: 'mutate', query: deleteQuery },
  async ({ query }) => {
    try {
      await deleteProfile(query.name);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:profiles:delete', status: 400, exposeMessage: true });
    }
  },
);
