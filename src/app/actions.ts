'use server'

import { getReadme, getTemplateYaml, getTemplateVariables, getTemplateConfigFiles, getTemplatePostDeployScript, getTemplates, syncRegistries } from '@/lib/registry';
import { getConfig } from '@/lib/config';

export async function fetchTemplates() {
  return await getTemplates();
}

export async function fetchReadme(name: string, type: 'template' | 'stack' = 'template', source: string = 'Built-in') {
  return await getReadme(name, type, source);
}

export async function fetchTemplateYaml(name: string, source: string = 'Built-in') {
    return await getTemplateYaml(name, source);
}

export async function fetchTemplateVariables(name: string, source: string = 'Built-in') {
    return await getTemplateVariables(name, source);
}

export async function fetchTemplateConfigFiles(name: string, source: string = 'Built-in') {
    return await getTemplateConfigFiles(name, source);
}

export async function fetchTemplatePostDeployScript(name: string, source: string = 'Built-in') {
    return await getTemplatePostDeployScript(name, source);
}

export async function syncAllRegistries() {
    await syncRegistries();
}

/**
 * Return stored secret values the wizard should re-use instead of
 * generating fresh random ones. Wizard pre-fills with these so an
 * operator who walks through `Configure` sees the actual passwords
 * their services already have; the server-side install runner then
 * applies the same override defensively (#615).
 *
 * Sourced from `loadSavedSecrets` so this surface stays in sync with
 * the install runner's reuse logic — both walk `config.installedSecrets`
 * plus the legacy `config.lldap` / `config.reverseProxy.npm` /
 * `config.adguard` fields.
 */
export async function fetchStoredVariableValues(): Promise<Record<string, string>> {
  const { loadSavedSecrets } = await import('@/lib/install/savedSecrets');
  return loadSavedSecrets(await getConfig());
}
