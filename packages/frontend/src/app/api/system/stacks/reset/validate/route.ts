import { NextResponse } from 'next/server';
import { z } from 'zod';
import { validateResetCombo } from '@/lib/install/resetValidation';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const ValidateBody = z.object({
  preserve: z.array(z.string()),
  node: z.string().optional(),
});

/**
 * POST /api/system/stacks/reset/validate
 *
 * Validates whether a given set of preserve groups forms a safe
 * combination. Returns `{ valid: boolean, errors: string[] }`.
 * Called by CleanInstallPanel.tsx on every checkbox toggle so the
 * operator sees instant feedback before committing to a wipe.
 */
export const POST = withApiHandler({ body: ValidateBody }, async ({ body }) => {
  const result = await validateResetCombo({
    preserve: body.preserve,
    node: body.node,
  });
  return NextResponse.json(result);
});
