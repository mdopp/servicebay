'use server';

import { getConfig, saveConfig, SSH_DIR } from '@/lib/config';
import { FritzBoxClient } from '@/lib/fritzbox/client';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface OnboardingStatus {
  needsSetup: boolean;
  hasGateway: boolean;
  hasSshKey: boolean;
  hasExternalLinks: boolean;
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

  return {
    needsSetup,
    hasGateway,
    hasSshKey,
    hasExternalLinks,
    features: {
        gateway: !!config.gateway,
        ssh: hasSshKey,
        updates: config.autoUpdate.enabled,
        registries: config.registries?.enabled ?? false,
        email: config.notifications?.email?.enabled ?? false,
        auth: !!config.auth?.password
    }
  };
}

export async function detectGateway() {
  // Simple heuristic: Try to find fritz.box
  try {
    // We can just try to connect? 
    // Or we can try to resolve DNS if we had a DNS tool
    // For now, let's just assume we want to guide the user to enter it.
    // There isn't a solid cross-platform "get default gateway" in node without executing shell commands (ip route)
    // which might differ in container vs host.
    
    // We can try a simple HEAD request to http://fritz.box
    new FritzBoxClient({ host: 'fritz.box' });
    // This is hard to "detect" without auth.
    return { detected: true, host: 'fritz.box', type: 'fritzbox' };
  } catch {
    return { detected: false };
  }
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
        channel: 'stable'
    };
    await saveConfig(config);
}

export async function saveRegistriesConfig(enabled: boolean) {
    const config = await getConfig();
    // Default registries if enabling
    const defaultRegistry = {
        name: 'ServiceBay Templates',
        url: 'https://github.com/mdopp/servicebay-templates'
    };
    
    if (enabled && (!config.registries?.items || config.registries.items.length === 0)) {
        config.registries = {
            enabled: true,
            items: [defaultRegistry]
        };
    } else {
        config.registries = {
            enabled,
            items: config.registries?.items || []
        };
    }
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
    await saveConfig(config);
}
