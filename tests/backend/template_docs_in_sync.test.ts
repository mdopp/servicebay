/**
 * Drift guard for docs/TEMPLATE_AUTHORING.md (#585).
 *
 * The annotation reference table inside the AUTOGEN markers is generated
 * from `src/lib/template/contract.ts:TEMPLATE_FIELDS`. If a contributor
 * adds a field to the contract but forgets to run
 * `npm run gen-template-docs`, the docs would silently rot. This test
 * fails CI in that case with a clear "run the script" message.
 */

import { describe, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('Template authoring docs', () => {
  it('docs/TEMPLATE_AUTHORING.md is in sync with src/lib/template/contract.ts', () => {
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/gen-template-docs.ts', '--check'],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    if (result.status !== 0) {
      // Surface both the script's own message (which already tells the
      // contributor how to fix it) and the raw output for debugging.
      throw new Error(
        `gen-template-docs --check failed:\n${result.stderr}${result.stdout}`,
      );
    }
  }, 30_000); // tsx cold-start can be a few seconds on CI
});
