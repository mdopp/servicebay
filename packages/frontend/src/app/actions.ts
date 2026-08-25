'use server'

import { getReadme, getTemplateYaml, getTemplateVariables, getTemplates, syncRegistries } from '@/lib/registry';
import {
  getStalledRegistries,
  type RegistrySyncRecord,
  type RegistrySyncSummary,
} from '@/lib/registrySyncState';

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

/**
 * Operator-initiated sync. `force` is deliberately true: the give-up state
 * (#2610) exists to stop *automatic* retries of a hopeless registry, and this
 * is the click that says "I fixed it, try again". Returns the per-registry
 * summary so the caller can report what actually refreshed instead of
 * assuming everything did.
 */
export async function syncAllRegistries(): Promise<RegistrySyncSummary> {
    return await syncRegistries({ force: true });
}

/** Registries that have stopped syncing, with the reason — for the page banner. */
export async function fetchStalledRegistries(): Promise<RegistrySyncRecord[]> {
    return await getStalledRegistries();
}
