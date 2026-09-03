import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { getConfig, saveConfig } from '@/lib/config';
import { OnboardingCompleteRequestSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

type Body = z.infer<typeof OnboardingCompleteRequestSchema>;

/**
 * Lock down MCP for fresh installs: read-only by default, dangerous-exec
 * patterns blocked. The operator opts into mutations from
 * Settings → Security → MCP Server. Existing installs (where the field is
 * already set) are left alone — only fields not yet present in the persisted
 * config get the safe defaults.
 */
function setSafeMcpDefaults(config: { mcp?: { allowMutations?: boolean; allowDangerousExec?: boolean } }) {
  if (!config.mcp) config.mcp = {};
  if (config.mcp.allowMutations === undefined) config.mcp.allowMutations = false;
  if (config.mcp.allowDangerousExec === undefined) config.mcp.allowDangerousExec = false;
}

/**
 * POST /api/system/onboarding/complete — mark the wizard done (#2745, was
 * `skipOnboarding` / `completeStackSetup` in `app/actions/onboarding.ts`).
 *
 * `target: 'setup'` closes onboarding itself (the "skip" button and the
 * finish path both use it); `target: 'stack'` clears only the stack-setup
 * follow-up, which is what the /setup page's Finish button does.
 */
export const POST = withApiHandler<Body>(
  { body: OnboardingCompleteRequestSchema },
  async ({ body }) => {
    const config = await getConfig();
    if (body.target === 'setup') {
      config.setupCompleted = true;
    } else {
      delete config.stackSetupPending;
    }
    setSafeMcpDefaults(config);
    await saveConfig(config);
    return { success: true as const };
  },
);
