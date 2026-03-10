import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from './dirs';
import { decrypt, encrypt } from './secrets';
import { LogLevel } from './logger';
import { PortMapping as GraphPortMapping } from './network/types';
import { normalizeExternalTargets } from './network/externalLinks';
import { ConfigTransformer } from './config/transformer';
import type { BackupConfig } from './backup/types';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export interface ExternalLink {
  id: string;
  name: string;
  url: string;
  description?: string;
  icon?: string;
  monitor?: boolean;
  ipTargets?: string[];
  ports?: GraphPortMapping[];
}

export interface RegistryConfig {
  name: string;
  url: string;
  branch?: string;
}

export interface RegistriesSettings {
  enabled: boolean;
  items: RegistryConfig[];
}

export interface GatewayConfig {
  type: 'fritzbox';
  host: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

export interface ProxyHostEntry {
  /** Full domain, e.g. "vault.dopp.cloud" */
  domain: string;
  /** Service template name, e.g. "vaultwarden" */
  service: string;
  /** Target port on the node */
  forwardPort: number;
  /** Whether the NPM proxy host was created successfully */
  created: boolean;
  /** Whether SSL (Let's Encrypt) has been configured */
  sslConfigured?: boolean;
  /** Timestamp of creation */
  createdAt?: string;
}

export interface ReverseProxyConfig {
  /** Public domain used for subdomains (e.g. "dopp.cloud") */
  publicDomain?: string;
  /** Proxy hosts created during stack deployment */
  hosts?: ProxyHostEntry[];
}

interface AgentRestartSchedule {
  enabled: boolean;
  time: string; // HH:MM (UTC)
  timezone?: string;
}

interface AgentProcessCleanup {
  enabled: boolean;
  dryRun?: boolean;
  maxAgeMinutes?: number;
}

export interface AgentConfig {
  sessionId?: string; // Read-only, auto-generated at server startup
  cleanupOrphansOnStart?: boolean;
  restartSchedule?: AgentRestartSchedule;
  gracefulShutdownTimeout?: number; // seconds
  processCleanup?: AgentProcessCleanup;
}

export interface AppConfig {
  logLevel?: LogLevel;
  serverName?: string; // Custom display name for this server
  domain?: string; // Optional domain for display
  gateway?: GatewayConfig;
  reverseProxy?: ReverseProxyConfig;
  agent?: AgentConfig;
  templateSettings?: Record<string, string>;
  autoUpdate: {
    enabled: boolean;
    schedule: string; // Cron syntax, e.g. "0 0 * * *" for midnight
    channel: 'stable' | 'test' | 'dev';
  };
  registries?: RegistriesSettings;
  externalLinks?: ExternalLink[];
  notifications?: {
    email?: {
      enabled: boolean;
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
      from: string;
      to: string[];
    };
  };
  auth?: {
    username?: string;
    password?: string;
  };
  oidc?: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    allowedGroups?: string[];
  };
  backup?: BackupConfig;
  setupCompleted?: boolean;
  stackSetupPending?: boolean;
}

export function getOidcCallbackUrl(config: { reverseProxy?: { publicDomain?: string } }): string {
  const domain = config.reverseProxy?.publicDomain;
  if (domain) {
    return `https://admin.${domain}/api/auth/oidc/callback`;
  }
  return 'http://localhost:3000/api/auth/oidc/callback';
}

const normalizeExternalLinkEntry = (link: ExternalLink): ExternalLink => {
  const normalizedTargets = normalizeExternalTargets(link.ipTargets ?? []);
  return {
    ...link,
    ipTargets: normalizedTargets,
  };
};

const normalizeExternalLinks = (links?: ExternalLink[]): ExternalLink[] | undefined => {
  if (!Array.isArray(links)) return links;
  return links.map(normalizeExternalLinkEntry);
};

const DEFAULT_CONFIG: AppConfig = {
  templateSettings: {},
  logLevel: 'info',
  agent: {
    cleanupOrphansOnStart: true,
    restartSchedule: {
      enabled: false,
      time: '03:00',
      timezone: 'UTC'
    },
    gracefulShutdownTimeout: 30,
    processCleanup: {
      enabled: true,
      dryRun: false,
      maxAgeMinutes: 60
    }
  },
  autoUpdate: {
    enabled: false,
    schedule: '0 0 * * *', // Daily at midnight
    channel: 'stable'
  }
};

const normalizeTemplateSettingsKeys = (settings?: Record<string, string>): Record<string, string> | undefined => {
  if (!settings) return settings;
  const normalized = { ...settings };
  if (typeof normalized.STACKS_DIR === 'string' && !normalized.DATA_DIR) {
    normalized.DATA_DIR = normalized.STACKS_DIR;
  }
  if ('STACKS_DIR' in normalized) {
    delete normalized.STACKS_DIR;
  }
  return normalized;
};

// Recursive helper to traverse config and apply a transform function to specific keys
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformConfig(obj: any, keysToTransform: string[], transformFn: (val: string) => string): any {
  if (Array.isArray(obj)) {
    return obj.map(v => transformConfig(v, keysToTransform, transformFn));
  } else if (obj !== null && typeof obj === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      if (keysToTransform.includes(key) && typeof obj[key] === 'string') {
        newObj[key] = transformFn(obj[key]);
      } else {
        newObj[key] = transformConfig(obj[key], keysToTransform, transformFn);
      }
    }
    return newObj;
  }
  return obj;
}

const SENSITIVE_KEYS = ['password', 'secret', 'token', 'key', 'apiKey'];

export async function getConfig(): Promise<AppConfig> {
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf-8');
    const rawConfig = JSON.parse(content);
    // Decrypt sensitive fields
    const config = transformConfig(rawConfig, SENSITIVE_KEYS, decrypt) as AppConfig;
    const merged = { ...DEFAULT_CONFIG, ...config };
    merged.templateSettings = normalizeTemplateSettingsKeys(merged.templateSettings) || {};
    merged.externalLinks = normalizeExternalLinks(merged.externalLinks);
    return merged;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  // Encrypt sensitive fields before saving
  const normalizedConfig: AppConfig = {
    ...config,
    externalLinks: normalizeExternalLinks(config.externalLinks),
    templateSettings: normalizeTemplateSettingsKeys(config.templateSettings)
  };
  const safeConfig = transformConfig(normalizedConfig, SENSITIVE_KEYS, encrypt);
  await fs.writeFile(CONFIG_PATH, JSON.stringify(safeConfig, null, 2));
}

/**
 * Reads the config and re-saves it to ensure all sensitive fields are encrypted.
 * Should be called on application startup.
 */
export async function migrateConfig(): Promise<void> {
  try {
    const transformer = new ConfigTransformer(CONFIG_PATH);
    await transformer.run();
    const config = await getConfig();
    // saveConfig automatically handles encryption of all sensitive keys
    await saveConfig(config);
  } catch (error) {
    console.warn('Failed to migrate/encrypt config on startup:', error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

export async function updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
  const current = await getConfig();
  const updated: AppConfig = deepMerge(current, updates);
  await saveConfig(updated);
  return updated;
}

