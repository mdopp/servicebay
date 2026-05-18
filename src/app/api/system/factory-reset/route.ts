import { z } from 'zod';
import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { performStackReset, StackResetError } from '@/lib/install/performStackReset';
import { clearSensitiveConfig } from '@/lib/install/clearSensitiveConfig';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/factory-reset
 *
 * The nuclear option (#623). Runs the same wipe as `/api/system/stacks/reset`
 * with `preserve: []` AND clears the sensitive in-memory config fields
 * that survive a stacks-only reset (installedSecrets, installManifest,
 * lldap/adguard legacy fields, NPM admin creds).
 *
 * The next wizard run should see no pre-fills — a true clean baseline.
 *
 * Distinct from the wizard's "Clean install" flow: that one is granular
 * (per-group preserve flags) and tuned for re-installing while keeping
 * useful state. This one is for the rare "I want zero baseline" case.
 *
 * Confirmation token: 'FACTORY-RESET' (different from the wizard's
 * 'RESET' so the operator can't accidentally type the wrong thing into
 * the wrong dialog).
 */
const Body = z.object({
  confirm: z.literal('FACTORY-RESET'),
  node: z.string().optional(),
});

export const POST = withApiHandler({ body: Body }, async ({ body }) => {
  try {
    const reset = await performStackReset({ preserve: [], node: body.node });
    const configCleared = await clearSensitiveConfig();
    logger.info('FactoryReset', `Wiped ${reset.deleted.length} services + cleared ${configCleared.cleared.length} config fields`);
    return NextResponse.json({ ok: true, reset, config: configCleared });
  } catch (error) {
    if (error instanceof StackResetError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
