import fs from 'fs/promises';
import path from 'path';
import { withApiHandler } from '@/lib/api/handler';
import { getConfig } from '@/lib/config';
import { SSH_DIR } from '@/lib/dirs';
import { getCurrentJob } from '@/lib/install/jobStore';
import type { OnboardingStatus } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

/** Either managed key shape counts — the wizard only asks "is there a key?". */
async function hasManagedSshKey(): Promise<boolean> {
  for (const name of ['id_rsa', 'id_ed25519']) {
    try {
      await fs.access(path.join(SSH_DIR, name));
      return true;
    } catch {
      // try the next key shape
    }
  }
  return false;
}

/**
 * GET /api/system/onboarding — what the first-run wizard needs to decide
 * whether to open and where to resume (#2745, was
 * `app/actions/onboarding.ts:checkOnboardingStatus`).
 */
export const GET = withApiHandler({}, async (): Promise<OnboardingStatus> => {
  const config = await getConfig();
  const hasSshKey = await hasManagedSshKey();
  const hasGateway = !!config.gateway;
  const activeJob = await getCurrentJob();

  return {
    // Setup is "needed" while the operator has neither finished the wizard
    // nor configured a gateway — the one component every install needs.
    needsSetup: !config.setupCompleted && !hasGateway,
    stackSetupPending: config.stackSetupPending === true,
    hasGateway,
    hasSshKey,
    hasExternalLinks: (config.externalLinks?.length ?? 0) > 0,
    installInProgress: activeJob
      ? {
          jobId: activeJob.id,
          startedAt: activeJob.startedAt,
          updatedAt: activeJob.updatedAt,
          source: activeJob.source,
        }
      : null,
    features: {
      gateway: hasGateway,
      ssh: hasSshKey,
      updates: config.autoUpdate.enabled,
      registries: config.registries?.enabled ?? false,
      email: config.notifications?.email?.enabled ?? false,
      auth: !!config.auth?.passwordHash,
    },
  };
});
