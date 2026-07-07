/**
 * Node major-version consistency across the four declaration sites (#2166,
 * ADR 0010). The minor deliberately floats on the Node 20 line, but the
 * MAJOR must agree everywhere or a native module compiled under one ABI can
 * be loaded under another — the "compiled against a different Node.js version"
 * crash that only surfaces at runtime on the box.
 *
 * Sources:
 *   - package.json     engines.node   (e.g. "20.x")
 *   - .nvmrc                           (e.g. "20")
 *   - .github/workflows/*.yml node-version (e.g. "20")
 *   - Dockerfile / Dockerfile.dev      FROM node:20-slim
 *
 * This test is the checklist for a Node-line bump: move all four together or
 * CI goes red.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Extract the leading major-version integer from a version-ish token. */
function major(token: string): number | null {
  const m = /(\d+)/.exec(token.trim());
  return m ? parseInt(m[1], 10) : null;
}

function packageEnginesMajor(): number | null {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
  const node: string | undefined = pkg.engines?.node;
  return node ? major(node) : null;
}

function nvmrcMajor(): number | null {
  const p = path.join(REPO_ROOT, '.nvmrc');
  if (!fs.existsSync(p)) return null;
  return major(fs.readFileSync(p, 'utf-8'));
}

/** Every `node-version: 'NN'` seen in the workflows. */
function workflowMajors(): { file: string; major: number }[] {
  const dir = path.join(REPO_ROOT, '.github', 'workflows');
  const out: { file: string; major: number }[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf-8');
    const re = /node-version:\s*['"]?(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ file: f, major: parseInt(m[1], 10) });
    }
  }
  return out;
}

/** Every `FROM node:NN...` base tag across the Dockerfiles at the repo root. */
function dockerfileMajors(): { file: string; major: number }[] {
  const out: { file: string; major: number }[] = [];
  for (const f of ['Dockerfile', 'Dockerfile.dev']) {
    const p = path.join(REPO_ROOT, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf-8');
    const re = /FROM\s+node:(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({ file: f, major: parseInt(m[1], 10) });
    }
  }
  return out;
}

describe('Node major version consistency (#2166, ADR 0010)', () => {
  it('all four declaration sites agree on the Node major version', () => {
    const pkg = packageEnginesMajor();
    const nvmrc = nvmrcMajor();
    const wf = workflowMajors();
    const docker = dockerfileMajors();

    // Every source must exist and be parseable.
    expect(pkg, 'package.json engines.node must declare a major').not.toBeNull();
    expect(nvmrc, '.nvmrc must declare a major').not.toBeNull();
    expect(wf.length, 'at least one workflow must set node-version').toBeGreaterThan(0);
    expect(docker.length, 'at least one Dockerfile must use a node base image').toBeGreaterThan(0);

    const expected = pkg!;
    const mismatches: string[] = [];
    if (nvmrc !== expected) mismatches.push(`.nvmrc → ${nvmrc}`);
    for (const w of wf) if (w.major !== expected) mismatches.push(`${w.file} node-version → ${w.major}`);
    for (const d of docker) if (d.major !== expected) mismatches.push(`${d.file} FROM node → ${d.major}`);

    expect(
      mismatches,
      `Node major mismatch (package.json engines = ${expected}):\n  ${mismatches.join('\n  ')}\n\n` +
      'All four sources (package.json / .nvmrc / workflows / Dockerfiles) must share the same Node ' +
      'major or a native module compiled under one ABI can crash under another. See docs/adr/0010.',
    ).toEqual([]);
  });
});
