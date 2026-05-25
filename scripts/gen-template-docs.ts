#!/usr/bin/env node
/**
 * Regenerate the template annotation reference table in
 * docs/TEMPLATE_AUTHORING.md from the single source of truth in
 * packages/backend/src/lib/template/contract.ts (#585).
 *
 * Run: `npm run gen-template-docs` (writes the file) or
 *      `npm run gen-template-docs -- --check` (CI: exits non-zero if
 *      the file would change).
 *
 * The generator only touches the block bracketed by
 *   <!-- AUTOGEN:TEMPLATE_FIELDS_START -->
 *   <!-- AUTOGEN:TEMPLATE_FIELDS_END -->
 * Everything else in the doc is hand-edited prose.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_FIELDS, type TemplateFieldSpec } from '../packages/backend/src/lib/template/contract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'TEMPLATE_AUTHORING.md');

const START = '<!-- AUTOGEN:TEMPLATE_FIELDS_START -->';
const END = '<!-- AUTOGEN:TEMPLATE_FIELDS_END -->';

function formatRequired(spec: TemplateFieldSpec): string {
  if (spec.required === true) return 'yes';
  if (spec.required === 'if-mustache-configs') return 'required if any `*.mustache` files';
  if (spec.default !== undefined) {
    const def = Array.isArray(spec.default)
      ? `[]`
      : typeof spec.default === 'string'
        ? `"${spec.default}"`
        : String(spec.default);
    return `optional (default \`${def}\`)`;
  }
  return 'optional';
}

function renderTable(): string {
  const header = '| Annotation | Required | Purpose |';
  const sep = '|---|---|---|';
  const rows = TEMPLATE_FIELDS.map(f => {
    return `| \`${f.annotation}\` | ${formatRequired(f)} | ${f.description} |`;
  });
  return [
    START,
    '<!-- This table is generated from packages/backend/src/lib/template/contract.ts:TEMPLATE_FIELDS by',
    '     scripts/gen-template-docs.ts. Run `npm run gen-template-docs` after editing',
    '     the field-spec table; do not hand-edit between these markers. -->',
    '',
    header,
    sep,
    ...rows,
    '',
    END,
  ].join('\n');
}

function patch(existing: string, replacement: string): string {
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `${path.relative(REPO_ROOT, DOC_PATH)} is missing the AUTOGEN markers — ` +
      `add a block bracketed by:\n  ${START}\n  ${END}\nbefore running this script.`,
    );
  }
  if (endIdx < startIdx) {
    throw new Error(`Markers out of order in ${DOC_PATH}`);
  }
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + END.length);
  return before + replacement + after;
}

function main(): void {
  const check = process.argv.includes('--check');
  const existing = fs.readFileSync(DOC_PATH, 'utf-8');
  const next = patch(existing, renderTable());

  if (existing === next) {
    process.stdout.write(`${path.relative(REPO_ROOT, DOC_PATH)} already in sync.\n`);
    return;
  }

  if (check) {
    process.stderr.write(
      `${path.relative(REPO_ROOT, DOC_PATH)} is out of date with packages/backend/src/lib/template/contract.ts.\n` +
      `Run \`npm run gen-template-docs\` to regenerate, then commit the result.\n`,
    );
    process.exit(1);
  }

  fs.writeFileSync(DOC_PATH, next);
  process.stdout.write(`Regenerated ${path.relative(REPO_ROOT, DOC_PATH)}.\n`);
}

main();
