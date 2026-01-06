import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

// In container, we map host's .servicebay to /app/data
// But os.homedir() is /root.
// So we should check if /app/data exists, otherwise use os.homedir()/.servicebay
const isContainer = existsSync('/.dockerenv') || (process.env.NODE_ENV === 'production' && existsSync('/app'));
export const DATA_DIR = process.env.DATA_DIR || (isContainer ? '/app/data' : path.join(os.homedir(), '.servicebay'));
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export interface ExternalLink {
  id: string;
  name: string;
  url: string;
  description?: string;
  monitor?: boolean;
  ip_targets?: string[]; // e.g. ["192.168.1.10:8123", "10.0.0.5:80"]
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReverseProxyConfig {
  // Configuration for the reverse proxy (e.g. global settings)
  // Currently managed via system/nginx endpoints
}

export interface AppConfig {
  gateway?: GatewayConfig;
  reverseProxy?: ReverseProxyConfig;
  autoUpdate: {
    enabled: boolean;
    schedule: string; // Cron syntax, e.g. "0 0 * * *" for midnight
    channel: 'stable' | 'beta';
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
  setupCompleted?: boolean;
}

const DEFAULT_CONFIG: AppConfig = {
  autoUpdate: {
    enabled: false,
    schedule: '0 0 * * *', // Daily at midnight
    channel: 'stable'
  }
};

export async function getConfig(): Promise<AppConfig> {
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}
