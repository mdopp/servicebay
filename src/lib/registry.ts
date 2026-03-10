
import fs from 'fs/promises';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { getConfig, RegistryConfig } from './config';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');
const STACKS_PATH = path.join(process.cwd(), 'stacks');
const CONTAINER_CONFIG_DIR = '/app/.servicebay';
const REGISTRIES_DIR = path.join(
  process.env.CONTAINER_CONFIG_DIR || CONTAINER_CONFIG_DIR,
  'registries'
);

// Default registry: the ServiceBay repo itself (public, no auth needed)
const DEFAULT_REGISTRY: RegistryConfig = {
  name: 'servicebay',
  url: 'https://github.com/mdopp/servicebay.git',
};

export interface Template {
  name: string;
  path: string;
  url: string;
  type: 'template' | 'stack';
  source: string;
}

export interface TemplateSettingsSchemaEntry {
    default: string;
    description?: string;
    required?: boolean;
}

const DEFAULT_TEMPLATE_SCHEMA: Record<string, TemplateSettingsSchemaEntry> = {
    DATA_DIR: {
        default: '/mnt/data',
        description: 'Base directory used by templates for persistent data',
        required: true
    }
};

export async function getTemplateSettingsSchema(): Promise<Record<string, TemplateSettingsSchemaEntry>> {
    const settingsPath = path.join(TEMPLATES_PATH, 'settings.json');
    try {
        const raw = await fs.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const variables = parsed?.variables || {};
        return {
            ...DEFAULT_TEMPLATE_SCHEMA,
            ...variables
        };
    } catch {
        return DEFAULT_TEMPLATE_SCHEMA;
    }
}

async function fetchDir(dirPath: string, type: 'template' | 'stack', source: string): Promise<Template[]> {
  try {
    // Check if directory exists
    try {
        await fs.access(dirPath);
    } catch {
        return [];
    }

    const items = await fs.readdir(dirPath, { withFileTypes: true });
    
    return items
        .filter(item => item.isDirectory() && !item.name.startsWith('.'))
        .map(item => ({
            name: item.name,
            path: path.join(dirPath, item.name),
            url: '', // No URL for local files
            type,
            source
        }));
  } catch (e) {
      console.error(`Error fetching ${type}s from ${source}:`, e);
      return [];
  }
}

function getRegistries(config: Awaited<ReturnType<typeof getConfig>>): RegistryConfig[] {
    let registries: RegistryConfig[] = [];

    if (Array.isArray(config.registries)) {
        registries = config.registries;
    } else if (config.registries?.enabled) {
        registries = config.registries.items || [];
    }

    // Always include the default registry if not already present
    if (!registries.some(r => r.name === DEFAULT_REGISTRY.name)) {
        registries = [DEFAULT_REGISTRY, ...registries];
    }

    return registries;
}

async function cloneSparse(url: string, dest: string, dirs: string[]) {
    // Shallow clone with sparse checkout — only pull the directories we need
    await execFileAsync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, dest]);
    await execFileAsync('git', ['sparse-checkout', 'set', ...dirs], { cwd: dest });
}

export async function syncRegistries() {
    const config = await getConfig();
    const registries = getRegistries(config);

    if (registries.length === 0) return;

    try {
        await fs.mkdir(REGISTRIES_DIR, { recursive: true });
    } catch {}

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        try {
            await fs.access(path.join(regPath, '.git'));
            // Exists — fetch latest and reset (shallow clones can't reliably git pull)
            console.log(`Updating registry ${reg.name}...`);
            const branch = reg.branch || 'main';
            await execAsync(`git fetch --depth 1 origin ${branch}`, { cwd: regPath });
            await execAsync(`git reset --hard origin/${branch}`, { cwd: regPath });
        } catch {
            // Doesn't exist, clone
            console.log(`Cloning registry ${reg.name}...`);
            try {
                await cloneSparse(reg.url, regPath, ['templates', 'stacks']);
            } catch {
                // Fallback to full clone if sparse checkout not supported
                await execFileAsync('git', ['clone', '--depth', '1', reg.url, regPath]);
            }
        }
    }
}

export async function getTemplates(): Promise<Template[]> {
    // 1. Built-in (fallback)
    const [builtinTemplates, builtinStacks] = await Promise.all([
        fetchDir(TEMPLATES_PATH, 'template', 'Built-in'),
        fetchDir(STACKS_PATH, 'stack', 'Built-in')
    ]);

    const allTemplates = [...builtinStacks, ...builtinTemplates];

    // 2. External Registries (override built-in by name)
    const config = await getConfig();
    const registries = getRegistries(config);

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        const [regTemplates, regStacks] = await Promise.all([
            fetchDir(path.join(regPath, 'templates'), 'template', reg.name),
            fetchDir(path.join(regPath, 'stacks'), 'stack', reg.name)
        ]);

        // Registry versions override built-in templates with the same name
        const regItems = [...regStacks, ...regTemplates];
        for (const item of regItems) {
            const idx = allTemplates.findIndex(t => t.name === item.name && t.type === item.type);
            if (idx !== -1) {
                allTemplates[idx] = item;
            } else {
                allTemplates.push(item);
            }
        }
    }

    return allTemplates;
}

export async function getReadme(name: string, type: 'template' | 'stack', source?: string): Promise<string | null> {
  const subdir = type === 'stack' ? 'stacks' : 'templates';

  // If a specific source is given, use it directly
  if (source && source !== 'Built-in') {
    try {
      const filePath = path.join(REGISTRIES_DIR, source, subdir, name, 'README.md');
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // Otherwise: check registries first, then fall back to built-in
  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      try {
        const filePath = path.join(REGISTRIES_DIR, reg.name, subdir, name, 'README.md');
        return await fs.readFile(filePath, 'utf-8');
      } catch { /* not in this registry */ }
    }
  }

  // Built-in fallback
  try {
    const basePath = type === 'stack' ? STACKS_PATH : TEMPLATES_PATH;
    const filePath = path.join(basePath, name, 'README.md');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function getTemplateYaml(name: string, source?: string): Promise<string | null> {
  // If a specific source is given, use it directly
  if (source && source !== 'Built-in') {
    try {
      const filePath = path.join(REGISTRIES_DIR, source, 'templates', name, 'template.yml');
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // Otherwise: check registries first (freshest), then fall back to built-in
  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      try {
        const filePath = path.join(REGISTRIES_DIR, reg.name, 'templates', name, 'template.yml');
        return await fs.readFile(filePath, 'utf-8');
      } catch { /* not in this registry */ }
    }
  }

  // Built-in fallback
  try {
    const filePath = path.join(TEMPLATES_PATH, name, 'template.yml');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** NPM proxy host settings passed to POST /api/nginx/proxy-hosts */
export interface ProxyConfig {
  allow_websocket_upgrade?: boolean;
  block_exploits?: boolean;
  caching_enabled?: boolean;
  http2_support?: boolean;
  ssl_forced?: boolean;
  /** Custom nginx directives injected into the server block */
  advanced_config?: string;
}

export interface OidcClientConfig {
  client_id: string;
  client_name: string;
  authorization_policy?: string;
  redirect_uris: string[];
  scopes?: string[];
}

export interface VariableMeta {
  type?: 'text' | 'password' | 'secret' | 'select' | 'device' | 'subdomain';
  description?: string;
  default?: string;
  options?: string[];
  devicePath?: string;
  /** For subdomain type: variable name referencing the target port, or a literal port number */
  proxyPort?: string;
  /** For subdomain type: service-specific NPM proxy host configuration */
  proxyConfig?: ProxyConfig;
  /** OIDC client to register with Authelia when this service is deployed */
  oidcClient?: OidcClientConfig;
}

export async function getTemplateVariables(name: string, source?: string): Promise<Record<string, VariableMeta> | null> {
  const tryRead = async (filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch { return null; }
  };

  if (source && source !== 'Built-in') {
    return tryRead(path.join(REGISTRIES_DIR, source, 'templates', name, 'variables.json'));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const result = await tryRead(path.join(REGISTRIES_DIR, reg.name, 'templates', name, 'variables.json'));
      if (result) return result;
    }
  }

  return tryRead(path.join(TEMPLATES_PATH, name, 'variables.json'));
}

export interface TemplateConfigFile {
  /** Filename without .mustache extension (e.g. "configuration.yml") */
  filename: string;
  /** Raw Mustache template content */
  content: string;
  /** Target path hint from template.yml volume mounts (set by caller) */
  targetPath?: string;
}

/** Find .mustache config files for a template (e.g. authelia/configuration.yml.mustache). */
export async function getTemplateConfigFiles(name: string, source?: string): Promise<TemplateConfigFile[]> {
  const scanDir = async (dirPath: string): Promise<TemplateConfigFile[]> => {
    try {
      const entries = await fs.readdir(dirPath);
      const mustacheFiles = entries.filter(f => f.endsWith('.mustache') && f !== 'template.yml.mustache');
      return Promise.all(mustacheFiles.map(async f => ({
        filename: f.replace(/\.mustache$/, ''),
        content: await fs.readFile(path.join(dirPath, f), 'utf-8'),
      })));
    } catch { return []; }
  };

  if (source && source !== 'Built-in') {
    return scanDir(path.join(REGISTRIES_DIR, source, 'templates', name));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const files = await scanDir(path.join(REGISTRIES_DIR, reg.name, 'templates', name));
      if (files.length > 0) return files;
    }
  }

  return scanDir(path.join(TEMPLATES_PATH, name));
}
