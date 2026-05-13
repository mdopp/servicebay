'use server';

import { getConfig, saveConfig } from '@/lib/config';
import { SSH_DIR } from '@/lib/dirs';
import { getCurrentJob } from '@/lib/install/jobStore';
import { abortJob } from '@/lib/install/runner';
import fs from 'fs/promises';
import path from 'path';

export interface OnboardingStatus {
  needsSetup: boolean;
  stackSetupPending: boolean;
  hasGateway: boolean;
  hasSshKey: boolean;
  hasExternalLinks: boolean;
  /**
   * Set when an install job is currently running in some session.
   * Other tabs/devices use this to attach to the existing job (or to
   * show a "another tab is installing" banner if the operator wants to
   * watch from elsewhere). The jobId lets the wizard call
   * `useStackInstall.attachToJob` to pick up live progress. A crashed
   * server flips its jobs to phase=crashed on next boot, so this never
   * stays stuck on a dead install.
   */
  installInProgress: { jobId: string; startedAt: string; source?: string } | null;
  features: {
    gateway: boolean;
    ssh: boolean;
    updates: boolean;
    registries: boolean;
    email: boolean;
    auth: boolean;
  }
}

export async function checkOnboardingStatus(): Promise<OnboardingStatus> {
  const config = await getConfig();
  
  // Check SSH Key
  // We use SSH_DIR which points to persistent volume or host mount
  const sshDir = SSH_DIR;
  let hasSshKey = false;
  try {
    await fs.access(path.join(sshDir, 'id_rsa'));
    hasSshKey = true;
  } catch {
    // try ed25519
    try {
        await fs.access(path.join(sshDir, 'id_ed25519'));
        hasSshKey = true;
    } catch {
        hasSshKey = false;
    }
  }

  // Determine if setup is needed
  // We consider setup needed if:
  // 1. Gateway is NOT configured AND we haven't explicitly disabled it (we don't have a flag for that yet, assume undefined means missing)
  const hasGateway = !!config.gateway;
  
  // 2. External links are empty (minor, but part of wizard)
  const hasExternalLinks = (config.externalLinks?.length ?? 0) > 0;

  // Setup is needed if we are missing key components that arguably every power user needs
  // But strictly, let's say "If config is basically empty"
  // For now, let's trigger if Gateway is missing.
  
  const needsSetup = !config.setupCompleted && !hasGateway;

  const activeJob = await getCurrentJob();
  const installInProgress = activeJob
    ? { jobId: activeJob.id, startedAt: activeJob.startedAt, source: activeJob.source }
    : null;

  return {
    needsSetup,
    stackSetupPending: config.stackSetupPending === true,
    hasGateway,
    hasSshKey,
    hasExternalLinks,
    installInProgress,
    features: {
        gateway: !!config.gateway,
        ssh: hasSshKey,
        updates: config.autoUpdate.enabled,
        registries: config.registries?.enabled ?? false,
        email: config.notifications?.email?.enabled ?? false,
        auth: !!config.auth?.passwordHash
    }
  };
}

export async function saveGatewayConfig(host: string, username?: string, password?: string) {
    const config = await getConfig();
    config.gateway = {
        type: 'fritzbox',
        host,
        username,
        password
    };
    await saveConfig(config);
    return { success: true };
}

export async function saveAutoUpdateConfig(enabled: boolean) {
    const config = await getConfig();
    config.autoUpdate = {
        ...config.autoUpdate,
        enabled,
    };
    await saveConfig(config);
}

export async function saveRegistriesConfig(enabled: boolean) {
    const config = await getConfig();
    // No default external registry. The previous seed
    // (`mdopp/servicebay-templates`) was a 404, and once #443 landed
    // and the container actually bundled git, every fresh install
    // tried to clone that URL on startup and aborted the whole sync
    // loop — which is why operators kept hitting templates frozen at
    // pre-sync state. `lib/registry.ts:getRegistries` already
    // prepends the canonical `mdopp/servicebay` default, so leaving
    // `items` empty here gives us the right behaviour: enable the
    // mechanism, but only sync the bundled built-in registry.
    config.registries = {
        enabled,
        items: config.registries?.items || []
    };
    await saveConfig(config);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function saveEmailConfig(emailConfig: any) {
    const config = await getConfig();
  
    if (!config.notifications) {
        config.notifications = {};
    }
  
    config.notifications.email = {
        enabled: true, // If saving config, assume enabled
        host: emailConfig.host,
        port: parseInt(emailConfig.port),
        secure: emailConfig.secure,
        user: emailConfig.user,
        pass: emailConfig.pass,
        from: emailConfig.from,
        to: emailConfig.recipients.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
    };
  
    await saveConfig(config);
}

export async function skipOnboarding() {
    // If user wants to skip, we should mark it as "seen"
    const config = await getConfig();
    config.setupCompleted = true;
    setSafeMcpDefaults(config);
    await saveConfig(config);
}

export async function completeStackSetup() {
    const config = await getConfig();
    delete config.stackSetupPending;
    setSafeMcpDefaults(config);
    await saveConfig(config);
}

/** Force-clear a stuck install. Surfaced in the UI so the operator can
 *  recover from a job that's somehow wedged without restarting the
 *  whole server. Aborts the runner if it's still alive; the job state
 *  transitions to phase=aborted via the runner's normal cleanup path. */
export async function forceClearInstallLock(): Promise<void> {
    const job = await getCurrentJob();
    if (job) abortJob(job.id);
}

/**
 * Lock down MCP for fresh installs: read-only by default, dangerous-exec
 * patterns blocked. The operator opts into mutations from
 * Settings → Integrations → MCP Server. Existing installs (where the
 * field is already set) are left alone — only fields not yet present in
 * the persisted config get the safe defaults.
 */
function setSafeMcpDefaults(config: { mcp?: { allowMutations?: boolean; allowDangerousExec?: boolean } }) {
    if (!config.mcp) config.mcp = {};
    if (config.mcp.allowMutations === undefined) {
        config.mcp.allowMutations = false;
    }
    if (config.mcp.allowDangerousExec === undefined) {
        config.mcp.allowDangerousExec = false;
    }
}
