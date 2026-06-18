import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This package is ESM ("type":"module") and runs as raw TS ESM via tsx, where the
// CommonJS `require` global does NOT exist. A bare `require('…')` here throws
// `ReferenceError: require is not defined` at runtime and crashed EVERY scan and
// apply (catalog.ts + main.ts). Guard against a regression: no source file may use
// the `require(` global, and the modules that need a CJS dep must bridge it via
// `createRequire(import.meta.url)` or a static `import`.

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');

const read = (rel: string) => readFileSync(path.join(srcRoot, rel), 'utf8');

// Strip comments + string literals so a `require(` inside a comment/doc doesn't
// trip the guard; we only care about real call expressions.
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

describe('disk-import-worker ESM runtime safety', () => {
  it('catalog.ts loads better-sqlite3 via a createRequire bridge, not the require global', () => {
    const code = codeOnly(read('engine/catalog.ts'));
    // It DOES call require(...), but only the module-scoped createRequire bridge —
    // never the (nonexistent in ESM) global. Assert the bridge is declared and that
    // every `require(` call is reachable only through it.
    expect(code).toContain('createRequire(import.meta.url)');
    expect(code).toMatch(/const\s+require\s*=\s*createRequire\(/);
  });

  it('main.ts uses a static import for child_process, no require( at all', () => {
    const code = codeOnly(read('cli/main.ts'));
    expect(code).not.toMatch(/(^|[^.\w])require\s*\(/);
    expect(read('cli/main.ts')).toMatch(
      /import\s*\{\s*spawnSync\s*\}\s*from\s*['"]node:child_process['"]/,
    );
  });

  it('ImportCatalog actually constructs (the require bridge resolves the native addon)', async () => {
    const { ImportCatalog } = await import('../engine/catalog');
    const cat = new ImportCatalog(':memory:');
    expect(cat.count()).toBe(0);
    cat.close();
  });
});
