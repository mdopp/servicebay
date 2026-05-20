/**
 * Stack ↔ codebase consistency suite (#624 / Phase 2A).
 *
 * Sibling of `template_consistency.test.ts`. Walks `stacks/`, parses
 * every `stack.yml`, and asserts:
 *   1. every manifest parses cleanly via `parseStackManifest`
 *   2. every `spec.templates` entry resolves to an existing `templates/<name>/`
 *   3. every `servicebay.depends-on-stacks` target resolves to another stack
 *      that itself has a `stack.yml`
 *   4. no dependency cycles between stacks (whole-stack graph)
 *   5. `metadata.name` matches the directory name
 *
 * Stacks without a `stack.yml` (legacy README-only `ai-stack/`,
 * `full-stack/`) are skipped — Phase 2B migrates them and at that
 * point every directory will have one.
 *
 * No fs writes, no agent — pure file-system + parsing.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { parseStackManifest, type StackManifest } from '@/lib/template/stackContract';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STACKS_DIR = path.join(REPO_ROOT, 'stacks');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

interface StackOnDisk {
  name: string;
  yamlPath: string;
  manifest: StackManifest;
}

function listStackDirs(): string[] {
  if (!fs.existsSync(STACKS_DIR)) return [];
  return fs.readdirSync(STACKS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);
}

function templateExists(name: string): boolean {
  const dir = path.join(TEMPLATES_DIR, name);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
}

/**
 * Load every stack with a parseable `stack.yml`. The "parses cleanly"
 * rule is asserted as its own test — this helper would otherwise need
 * to either skip broken manifests (hiding regressions) or throw
 * (corrupting every test downstream of it).
 */
function loadValidStacks(): { stacks: StackOnDisk[]; parseFailures: string[] } {
  const stacks: StackOnDisk[] = [];
  const parseFailures: string[] = [];
  for (const name of listStackDirs()) {
    const yamlPath = path.join(STACKS_DIR, name, 'stack.yml');
    if (!fs.existsSync(yamlPath)) continue;
    const text = fs.readFileSync(yamlPath, 'utf-8');
    const result = parseStackManifest(text);
    if (!result.ok) {
      parseFailures.push(`${name}:\n  ${result.errors.join('\n  ')}`);
      continue;
    }
    stacks.push({ name, yamlPath, manifest: result.manifest });
  }
  return { stacks, parseFailures };
}

describe('stack consistency', () => {
  it('every stack.yml parses cleanly', () => {
    const { parseFailures } = loadValidStacks();
    if (parseFailures.length > 0) {
      throw new Error(
        `One or more stacks have invalid manifests:\n\n${parseFailures.join('\n\n')}\n\n` +
        'Fix the listed annotations and re-run.',
      );
    }
    // Bare assertion so the test still records a positive in test counts
    // when no stacks have a manifest yet (Phase 2A is schema-only — Phase
    // 2B will migrate the first stacks).
    expect(parseFailures).toEqual([]);
  });

  it('metadata.name matches the directory name', () => {
    const { stacks } = loadValidStacks();
    const mismatches = stacks
      .filter(s => s.manifest.name !== s.name)
      .map(s => `${s.name}: metadata.name="${s.manifest.name}"`);
    if (mismatches.length > 0) {
      throw new Error(
        `Stack directory and metadata.name must match:\n  ${mismatches.join('\n  ')}`,
      );
    }
  });

  it('every spec.templates entry resolves to an existing templates/<name>/', () => {
    const { stacks } = loadValidStacks();
    const missing: string[] = [];
    for (const s of stacks) {
      for (const t of s.manifest.templates) {
        if (!templateExists(t)) {
          missing.push(`stacks/${s.name} → templates/${t}/ (missing)`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Stack manifest references a non-existent template:\n  ${missing.join('\n  ')}\n` +
        'Either create the template directory or remove the entry from spec.templates.',
      );
    }
  });

  it('every servicebay.depends-on-stacks target resolves to another stack with a manifest', () => {
    const { stacks } = loadValidStacks();
    const knownStacks = new Set(stacks.map(s => s.name));
    const dangling: string[] = [];
    for (const s of stacks) {
      for (const dep of s.manifest.dependsOnStacks) {
        if (!knownStacks.has(dep)) {
          dangling.push(`stacks/${s.name} → depends-on-stacks "${dep}" (not found)`);
        }
      }
    }
    if (dangling.length > 0) {
      throw new Error(
        `Stack manifest depends on an unknown stack:\n  ${dangling.join('\n  ')}\n` +
        'Either create the dependency stack\'s manifest or remove the entry.',
      );
    }
  });

  it('the stack dependency graph has no cycles', () => {
    const { stacks } = loadValidStacks();
    const graph = new Map<string, string[]>();
    for (const s of stacks) graph.set(s.name, s.manifest.dependsOnStacks);

    // Three-state DFS — white / grey / black. A grey hit means a back-
    // edge → cycle. Reports the involved nodes to point the operator at
    // the right manifests to edit.
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const name of graph.keys()) color.set(name, WHITE);

    const cycles: string[][] = [];
    const stack: string[] = [];

    const visit = (node: string): boolean => {
      color.set(node, GREY);
      stack.push(node);
      for (const dep of graph.get(node) ?? []) {
        const c = color.get(dep);
        if (c === undefined) continue; // dangling deps are caught by their own test
        if (c === GREY) {
          // Cycle: slice the path from `dep` to the current node, append
          // dep again to make the closure obvious in the error.
          const idx = stack.indexOf(dep);
          cycles.push([...stack.slice(idx), dep]);
          continue;
        }
        if (c === WHITE && visit(dep)) return true;
      }
      stack.pop();
      color.set(node, BLACK);
      return false;
    };

    for (const node of graph.keys()) {
      if (color.get(node) === WHITE) visit(node);
    }

    if (cycles.length > 0) {
      const detail = cycles.map(c => c.join(' → ')).join('\n  ');
      throw new Error(`Stack dependency graph has cycle(s):\n  ${detail}`);
    }
  });
});
