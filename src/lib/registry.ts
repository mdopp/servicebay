
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getConfig, RegistryConfig } from './config';

const execAsync = promisify(exec);

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');
const STACKS_PATH = path.join(process.cwd(), 'stacks');
const CONTAINER_CONFIG_DIR = '/app/.servicebay';
const REGISTRIES_DIR = path.join(
  process.env.CONTAINER_CONFIG_DIR || (process.env.NODE_ENV === 'production' ? CONTAINER_CONFIG_DIR : path.join(os.homedir(), '.servicebay')), 
  'registries'
);

export interface Template {
  name: string;
  path: string;
  url: string;
  type: 'template' | 'stack';
  source: string;
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

export async function syncRegistries() {
    const config = await getConfig();
    let registries: RegistryConfig[] = [];
    
    if (Array.isArray(config.registries)) {
        registries = config.registries;
    } else if (config.registries?.enabled) {
        registries = config.registries.items || [];
    }

    if (registries.length === 0) return;

    try {
        await fs.mkdir(REGISTRIES_DIR, { recursive: true });
    } catch {}

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        try {
            await fs.access(regPath);
            // Exists, pull
            console.log(`Updating registry ${reg.name}...`);
            await execAsync('git pull', { cwd: regPath });
        } catch {
            // Doesn't exist, clone
            console.log(`Cloning registry ${reg.name}...`);
            await execAsync(`git clone ${reg.url} "${regPath}"`);
        }
    }
}

export async function getTemplates(): Promise<Template[]> {
    // 1. Built-in
    const [builtinTemplates, builtinStacks] = await Promise.all([
        fetchDir(TEMPLATES_PATH, 'template', 'Built-in'),
        fetchDir(STACKS_PATH, 'stack', 'Built-in')
    ]);

    let allTemplates = [...builtinStacks, ...builtinTemplates];

    // 2. External Registries
    const config = await getConfig();
    let registries: RegistryConfig[] = [];
    
    if (Array.isArray(config.registries)) {
        registries = config.registries;
    } else if (config.registries?.enabled) {
        registries = config.registries.items || [];
    }

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        const [regTemplates, regStacks] = await Promise.all([
            fetchDir(path.join(regPath, 'templates'), 'template', reg.name),
            fetchDir(path.join(regPath, 'stacks'), 'stack', reg.name)
        ]);
        allTemplates = [...allTemplates, ...regStacks, ...regTemplates];
    }

    return allTemplates;
}

export async function getReadme(name: string, type: 'template' | 'stack', source: string = 'Built-in'): Promise<string | null> {
  try {
    let basePath;
    if (source === 'Built-in') {
        basePath = type === 'stack' ? STACKS_PATH : TEMPLATES_PATH;
    } else {
        basePath = path.join(REGISTRIES_DIR, source, type === 'stack' ? 'stacks' : 'templates');
    }
    
    const filePath = path.join(basePath, name, 'README.md');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
      return null;
  }
}

export async function getTemplateYaml(name: string, source: string = 'Built-in'): Promise<string | null> {
  try {
    let basePath;
    if (source === 'Built-in') {
        basePath = TEMPLATES_PATH;
    } else {
        basePath = path.join(REGISTRIES_DIR, source, 'templates');
    }

    const filePath = path.join(basePath, name, 'template.yml');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
      return null;
  }
}
