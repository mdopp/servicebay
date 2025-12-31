'use server'

import { getReadme, getTemplateYaml, getTemplates } from '@/lib/registry';

export async function fetchTemplates() {
  return await getTemplates();
}

export async function fetchReadme(name: string, type: 'template' | 'stack' = 'template') {
  return await getReadme(name, type);
}

export async function fetchTemplateYaml(name: string) {
    return await getTemplateYaml(name);
}
