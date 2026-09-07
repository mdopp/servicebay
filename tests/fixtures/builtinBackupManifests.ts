/**
 * The backup manifests this repo's OWN templates declare, resolved off disk —
 * the test-side equivalent of what the box does at backup time (#2858 slice C).
 *
 * Before slice C this was a literal table (`SERVICE_BACKUP_MANIFESTS`) that
 * tests could index by service name. The table is gone: a template declares its
 * own backup, so a test that wants "what nginx actually backs up" has to ask
 * the same question the producer asks. This helper asks it once, through the
 * SAME pure bridge the runtime and `scripts/check-backup-coverage.ts` use, so a
 * test can never pass against a manifest the box would not build.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { resolveTemplateBackupDeclaration } from '@/lib/externalBackup/backupDeclaration';
import type { ServiceBackupManifest } from '@servicebay/backup-manifest';

const TEMPLATES_DIR = path.resolve(__dirname, '../../templates');

/** The raw `servicebay.backup` body of a template.yml, or `undefined`. */
function backupAnnotation(yamlText: string): string | undefined {
  // Mustache placeholders make a template.yml invalid YAML; swap them for
  // plain tokens exactly as the coverage gate does. No backup declaration
  // carries one (the parser refuses `{{…}}` in a backup path), so this only
  // affects the parts of the document we don't read here.
  const scannable = yamlText
    .replace(/\{\{[#^/!][^{}]*\}\}/g, '')
    .replace(/\{\{\{?\s*([A-Za-z0-9_.]+)\s*\}?\}\}/g, 'SBVAR_$1');
  const docs = yaml.loadAll(scannable) as (
    { kind?: unknown; metadata?: { annotations?: Record<string, unknown> } } | null
  )[];
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object' || doc.kind !== 'Pod') continue;
    const raw = doc.metadata?.annotations?.['servicebay.backup'];
    if (typeof raw === 'string') return raw;
  }
  return undefined;
}

/** Template names this repo ships. */
export function builtinTemplateNames(): string[] {
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => existsSync(path.join(TEMPLATES_DIR, name, 'template.yml')))
    .sort();
}

/** Every manifest the built-in templates declare, in template order. */
export function builtinBackupManifests(): ServiceBackupManifest[] {
  return builtinTemplateNames().flatMap(template => {
    const text = readFileSync(path.join(TEMPLATES_DIR, template, 'template.yml'), 'utf8');
    return resolveTemplateBackupDeclaration(template, backupAnnotation(text)).manifests;
  });
}

/** One service's declared manifest. Throws rather than returning undefined —
 *  a test asking for a manifest that no template declares is a broken test,
 *  and a `!` non-null assertion would hide that behind a null-deref later. */
export function builtinManifest(service: string): ServiceBackupManifest {
  const found = builtinBackupManifests().find(m => m.service === service);
  if (!found) throw new Error(`no built-in template declares a backup for "${service}"`);
  return found;
}
