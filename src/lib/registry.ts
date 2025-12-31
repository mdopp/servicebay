
import fs from 'fs/promises';
import path from 'path';

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');
const STACKS_PATH = path.join(process.cwd(), 'stacks');

export interface Template {
  name: string;
  path: string;
  url: string;
  type: 'template' | 'stack';
}

async function fetchDir(dirPath: string, type: 'template' | 'stack'): Promise<Template[]> {
  try {
    // Check if directory exists
    try {
        await fs.access(dirPath);
    } catch {
        return [];
    }

    const items = await fs.readdir(dirPath, { withFileTypes: true });
    
    return items
        .filter(item => item.isDirectory())
        .map(item => ({
            name: item.name,
            path: path.join(dirPath, item.name),
            url: '', // No URL for local files
            type
        }));
  } catch (e) {
      console.error(`Error fetching ${type}s:`, e);
      return [];
  }
}

export async function getTemplates(): Promise<Template[]> {
    const [templates, stacks] = await Promise.all([
        fetchDir(TEMPLATES_PATH, 'template'),
        fetchDir(STACKS_PATH, 'stack')
    ]);
    return [...stacks, ...templates];
}

export async function getReadme(name: string, type: 'template' | 'stack'): Promise<string | null> {
  try {
    const basePath = type === 'stack' ? STACKS_PATH : TEMPLATES_PATH;
    const filePath = path.join(basePath, name, 'README.md');
    return await fs.readFile(filePath, 'utf-8');
  } catch (e) {
      return null;
  }
}

export async function getTemplateYaml(name: string): Promise<string | null> {
  try {
    const filePath = path.join(TEMPLATES_PATH, name, 'template.yml');
    return await fs.readFile(filePath, 'utf-8');
  } catch (e) {
      return null;
  }
}
