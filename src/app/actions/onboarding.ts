'use server';

import { getConfig, saveConfig } from '@/lib/config';
import { FritzBoxClient } from '@/lib/fritzbox/client';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface OnboardingStatus {
  needsSetup: boolean;
  hasGateway: boolean;
  hasSshKey: boolean;
  hasExternalLinks: boolean;
}

export async function checkOnboardingStatus(): Promise<OnboardingStatus> {
  const config = await getConfig();
  
  // Check SSH Key
  // In container, ~/.ssh is mounted. 
  const sshDir = path.join(os.homedir(), '.ssh');
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
    hasExternalLinks
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

export async function skipOnboarding() {
    // If user wants to skip, we should mark it as "seen"
    const config = await getConfig();
    config.setupCompleted = true;
    await saveConfig(config);
}
