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
 * Return stored secret values that the wizard should re-use on a
 * non-clean reinstall instead of generating new random values.
 *
 * Called by startConfigure when cleanInstall is false so that services
 * like LLDAP (which only reads its admin password from env on first DB
 * init) continue to work with the password already baked into their
 * data volume.
 */
export async function fetchStoredVariableValues(): Promise<Record<string, string>> {
  const config = await getConfig();
  const values: Record<string, string> = {};
  if (config.lldap?.password)           values['LLDAP_ADMIN_PASSWORD']   = config.lldap.password;
  if (config.reverseProxy?.npm?.password) values['NGINX_ADMIN_PASSWORD'] = config.reverseProxy.npm.password;
  if (config.reverseProxy?.npm?.email)    values['NGINX_ADMIN_EMAIL']    = config.reverseProxy.npm.email;
  if (config.adguard?.password)          values['ADGUARD_ADMIN_PASSWORD'] = config.adguard.password;
  return values;
}
