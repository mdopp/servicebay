'use server'

import { getReadme, getTemplateYaml, getTemplateVariables, getTemplateConfigFiles, getTemplatePostDeployScript, getTemplateMigrationScripts, getTemplates, syncRegistries } from '@/lib/registry';

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

export async function fetchTemplateMigrationScripts(name: string, source: string = 'Built-in') {
    return await getTemplateMigrationScripts(name, source);
}

export async function syncAllRegistries() {
    await syncRegistries();
}
