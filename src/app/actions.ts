'use server'

import { getReadme, getTemplateYaml, getTemplates, syncRegistries } from '@/lib/registry';

export async function fetchTemplates() {
  return await getTemplates();
}

export async function fetchReadme(name: string, type: 'template' | 'stack' = 'template', source: string = 'Built-in') {
  return await getReadme(name, type, source);
}

export async function fetchTemplateYaml(name: string, source: string = 'Built-in') {
    return await getTemplateYaml(name, source);
}

export async function syncAllRegistries() {
    await syncRegistries();
}
