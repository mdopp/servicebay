/**
 * Build-time consistency checks for `templates/<name>/migrations/*.py`
 * scripts (#352 phase 3).
 *
 * These rules catch the kinds of typos that would only surface during
 * a real upgrade (when the operator is mid-deploy and least equipped
 * to debug), so we want them to fail CI:
 *
 *  1. Every file under `migrations/` matches the canonical
 *     `v{N}-to-v{M}.py` filename pattern.
 *  2. Each migration is a single-step hop (`toVersion == fromVersion+1`).
 *     v1→v3 skips imply a missing v2 step.
 *  3. The template's `servicebay.schema-version` is consistent with the
 *     migrations on disk: max migration `toVersion` must equal the
 *     declared schema-version.
 *  4. Python scripts compile (`python3 -m py_compile`) so a stray
 *     syntax error doesn't reach a real deploy.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { parseTemplateSchemaVersion } from '@/lib/templateSchemaVersion';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

interface TemplateMigrationInfo {
  templateName: string;
  schemaVersion: number;
  migrations: { filename: string; fromVersion: number; toVersion: number; fullPath: string }[];
}

function listTemplatesWithMigrations(): TemplateMigrationInfo[] {
  const out: TemplateMigrationInfo[] = [];
  for (const entry of fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templateDir = path.join(TEMPLATES_DIR, entry.name);
    const yamlPath = path.join(templateDir, 'template.yml');
    if (!fs.existsSync(yamlPath)) continue;
    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
    const schemaVersion = parseTemplateSchemaVersion(yamlContent);
    const migrationsDir = path.join(templateDir, 'migrations');
    let migrations: TemplateMigrationInfo['migrations'] = [];
    if (fs.existsSync(migrationsDir) && fs.statSync(migrationsDir).isDirectory()) {
      const filenameRe = /^v(\d+)-to-v(\d+)\.py$/;
      migrations = fs.readdirSync(migrationsDir)
        .filter(f => !f.endsWith('.pyc'))
        .filter(f => f !== '__pycache__')
        .map(filename => {
          const m = filenameRe.exec(filename);
          if (!m) return { filename, fromVersion: -1, toVersion: -1, fullPath: path.join(migrationsDir, filename) };
          return {
            filename,
            fromVersion: parseInt(m[1], 10),
            toVersion: parseInt(m[2], 10),
            fullPath: path.join(migrationsDir, filename),
          };
        });
    }
    out.push({ templateName: entry.name, schemaVersion, migrations });
  }
  return out;
}

const templates = listTemplatesWithMigrations();
const templatesWithMigrations = templates.filter(t => t.migrations.length > 0);

describe('Template migration scripts — filename + structure', () => {
  it('every migration file matches v{N}-to-v{M}.py', () => {
    const offenders: { template: string; filename: string }[] = [];
    for (const t of templates) {
      for (const m of t.migrations) {
        if (m.fromVersion < 0 || m.toVersion < 0) {
          offenders.push({ template: t.templateName, filename: m.filename });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map(o => `  templates/${o.template}/migrations/${o.filename}`).join('\n');
      throw new Error(
        `Found ${offenders.length} migration file(s) with non-canonical names:\n${msg}\n\n` +
        `Expected pattern: v{N}-to-v{M}.py (e.g. v1-to-v2.py).`,
      );
    }
  });

  it('every migration is a single-step hop (toVersion == fromVersion + 1)', () => {
    const offenders: { template: string; filename: string; reason: string }[] = [];
    for (const t of templates) {
      for (const m of t.migrations) {
        if (m.fromVersion < 0) continue; // covered by the filename test
        if (m.toVersion !== m.fromVersion + 1) {
          offenders.push({
            template: t.templateName,
            filename: m.filename,
            reason: `from=${m.fromVersion} to=${m.toVersion} — expected to=${m.fromVersion + 1}`,
          });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map(o => `  templates/${o.template}/migrations/${o.filename}: ${o.reason}`).join('\n');
      throw new Error(
        `Found ${offenders.length} multi-step migration file(s):\n${msg}\n\n` +
        `Split into one-step hops (v1-to-v2.py + v2-to-v3.py instead of v1-to-v3.py).`,
      );
    }
  });

  it('every migration toVersion is <= the template schema-version', () => {
    // A migration toVersion higher than the declared schema-version
    // means somebody wrote v3-to-v4.py without bumping the annotation —
    // operators will never reach the migration. The inverse is fine:
    // a bump can ship without a migration when no data move is needed
    // (the home-assistant v2→v3 bump for self-healing proxies, for
    // example — config-only, nothing to migrate on disk).
    const offenders: { template: string; filename: string; declared: number; toVersion: number }[] = [];
    for (const t of templatesWithMigrations) {
      for (const m of t.migrations) {
        if (m.fromVersion < 0) continue; // covered by the filename test
        if (m.toVersion > t.schemaVersion) {
          offenders.push({
            template: t.templateName,
            filename: m.filename,
            declared: t.schemaVersion,
            toVersion: m.toVersion,
          });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map(o => `  templates/${o.template}/migrations/${o.filename}: targets v${o.toVersion} but schema-version is "${o.declared}"`).join('\n');
      throw new Error(
        `Migration target beyond declared schema-version:\n${msg}\n\n` +
        `Bump servicebay.schema-version in template.yml or remove the unreachable migration script.`,
      );
    }
  });

  // py_compile is a few hundred ms per script — guard behind a feature
  // flag so dev test loops stay snappy. CI sets it; local runs can opt
  // in with `RUN_PY_COMPILE=1 npm test`.
  const RUN_PY_COMPILE = process.env.CI === 'true' || process.env.RUN_PY_COMPILE === '1';
  (RUN_PY_COMPILE ? it : it.skip)('every migration script python3 -m py_compile clean', () => {
    const offenders: { path: string; stderr: string }[] = [];
    for (const t of templates) {
      for (const m of t.migrations) {
        if (m.fromVersion < 0) continue;
        const res = spawnSync('python3', ['-m', 'py_compile', m.fullPath], { encoding: 'utf-8' });
        if (res.status !== 0) {
          offenders.push({ path: m.fullPath, stderr: res.stderr });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Template migration scripts — Docker image coverage (#2166)', () => {
  // A migration file that passes the repo-side chain validation above but is
  // NOT copied into the runner image reads identically on the box to a
  // *missing* step: the runner aborts every redeploy with "migration chain
  // incomplete" (memory: schema_bump_migration_and_real_redeploy_verify).
  // A glob miss in the Dockerfile is therefore a silent, box-only failure the
  // repo-side tests never see. Assert here that whatever the Dockerfile copies
  // into the image would cover every `templates/*/migrations/*.py` on disk.
  //
  // The migrations live under `templates/`, which the runner stage copies
  // wholesale (`COPY --from=builder /app/templates ./templates`). This test
  // fails the moment that COPY is narrowed to a glob that could drop a
  // migration file (e.g. someone switching to `COPY .../templates/*/*.yml`).
  const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');

  /** COPY lines in the runner stage that land files at `./templates`. */
  function runnerTemplateCopyDests(): string[] {
    const text = fs.readFileSync(DOCKERFILE, 'utf-8');
    const dests: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      // Match `COPY [--from=...] <src...> <dest>` whose dest is the templates tree.
      const m = /^COPY\s+(.*)$/i.exec(line);
      if (!m) continue;
      const parts = m[1].split(/\s+/).filter(p => !p.startsWith('--'));
      if (parts.length < 2) continue;
      const dest = parts[parts.length - 1];
      const srcs = parts.slice(0, -1);
      // The wholesale `COPY . .` in the builder stage and the runner's
      // `COPY --from=builder /app/templates ./templates` both deliver the
      // templates dir. We care about the runner dest landing at ./templates.
      if (dest === './templates' || dest === './templates/' || dest === 'templates') {
        dests.push(`${srcs.join(' ')} -> ${dest}`);
      }
    }
    return dests;
  }

  it('the runner image copies the whole templates/ tree (covers every migration file)', () => {
    const copies = runnerTemplateCopyDests();
    // There must be exactly one directory-level copy of templates/ — a
    // narrower per-file glob would risk dropping .py migration scripts.
    expect(copies.length).toBeGreaterThanOrEqual(1);
    const text = fs.readFileSync(DOCKERFILE, 'utf-8');
    // The copy must be a *directory* copy (src ends in `templates`), not a
    // glob like `templates/*/template.yml` that would exclude migrations.
    const dirCopy = /COPY\s+--from=\S+\s+\S*\/templates\s+\.\/templates\b/.test(text);
    expect(
      dirCopy,
      'Dockerfile must copy the templates/ directory wholesale into the runner image ' +
      '(`COPY --from=builder /app/templates ./templates`). A per-file glob risks dropping ' +
      'migration scripts, which surfaces on the box as "migration chain incomplete".',
    ).toBe(true);
  });

  it('every on-disk migration file lives under templates/ (so the dir copy covers it)', () => {
    // Guards the assumption above: if a migration script is ever placed
    // outside templates/ it would fall out of the wholesale copy and would
    // need its own COPY line + this test updated.
    const strays: string[] = [];
    for (const t of templatesWithMigrations) {
      for (const m of t.migrations) {
        if (m.fromVersion < 0) continue;
        const rel = path.relative(TEMPLATES_DIR, m.fullPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          strays.push(m.fullPath);
        }
      }
    }
    expect(strays).toEqual([]);
    // Sanity: we actually found migration files to guard (the test isn't
    // vacuously passing on an empty set).
    expect(templatesWithMigrations.length).toBeGreaterThan(0);
  });
});

describe('Template migration scripts — discovery via getTemplateMigrationScripts', () => {
  it('discovers home-assistant v1-to-v2.py from the built-in catalog', async () => {
    const { getTemplateMigrationScripts } = await import('@/lib/registry');
    const scripts = await getTemplateMigrationScripts('home-assistant', 'Built-in');
    expect(scripts.length).toBeGreaterThanOrEqual(1);
    const v1to2 = scripts.find(s => s.filename === 'v1-to-v2.py');
    expect(v1to2).toBeDefined();
    expect(v1to2?.fromVersion).toBe(1);
    expect(v1to2?.toVersion).toBe(2);
    expect(v1to2?.content).toContain('def main()');
  });

  it('returns an empty array for templates without a migrations/ dir', async () => {
    const { getTemplateMigrationScripts } = await import('@/lib/registry');
    const scripts = await getTemplateMigrationScripts('adguard', 'Built-in');
    expect(scripts).toEqual([]);
  });
});
