import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.servicebay', 'config.json');

export interface ExternalLink {
  id: string;
  name: string;
  url: string;
  description?: string;
  monitor?: boolean;
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
  enabled: boolean;
  type: 'fritzbox';
  host: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

export interface AppConfig {
  gateway?: GatewayConfig;
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
