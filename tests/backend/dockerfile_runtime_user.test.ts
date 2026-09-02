/**
 * The production image's runtime user must be a *decision*, not a leftover
 * (#2722).
 *
 * The runner stage used to end with a bare, unexplained `# USER nextjs` — a
 * commented-out directive that reads like something half-done. It is actually
 * load-bearing: under rootless podman the container's uid 0 maps to the host
 * user that runs the quadlet, which owns the bind-mounted podman socket, the
 * DATA_DIR and the host SSH key; any other container uid lands in that user's
 * subuid range and can reach none of them.
 *
 * A commented-out `USER` cannot say that, so this test forbids the shape and
 * demands the reasoning instead: run unprivileged, or state — dated, with the
 * issue that tracks the way out — why not. When `USER nextjs` finally lands
 * (#2749), the root branch simply stops applying and this test stays green.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');

const lines = (): string[] => fs.readFileSync(DOCKERFILE, 'utf-8').split('\n');

/** The contiguous run of `#` comment lines immediately above `index`. */
function commentBlockAbove(all: string[], index: number): string {
  const block: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    if (!/^\s*#/.test(all[i])) break;
    block.unshift(all[i]);
  }
  return block.join('\n');
}

describe('Dockerfile runtime user (#2722)', () => {
  it('carries no commented-out USER directive', () => {
    const dangling = lines().filter((l) => /^\s*#\s*USER\s+\S/.test(l));

    expect(
      dangling.map((l) => l.trim()),
      'A commented-out `USER` line states no reason and reads as an oversight. ' +
        'Either run as that user, or write `USER root` with the reasoning above it.',
    ).toEqual([]);
  });

  it('declares exactly one explicit USER in the runner stage', () => {
    const active = lines().filter((l) => /^\s*USER\s+\S/.test(l));

    expect(
      active.map((l) => l.trim()),
      'The production image must name its runtime user explicitly — an implicit ' +
        'root (no USER instruction at all) is the same silence this test exists to stop.',
    ).toHaveLength(1);
  });

  it('justifies `USER root` with a dated reason and a tracking issue', () => {
    const all = lines();
    const idx = all.findIndex((l) => /^\s*USER\s+\S/.test(l));
    expect(idx, 'no USER instruction found in the Dockerfile').toBeGreaterThanOrEqual(0);

    const user = all[idx].trim().replace(/^USER\s+/, '');
    if (user !== 'root') return; // running unprivileged — nothing to justify.

    const why = commentBlockAbove(all, idx);

    expect(
      /\b\d{4}-\d{2}-\d{2}\b/.test(why),
      'Running as root needs a DATED justification directly above `USER root` — ' +
        'without a date nobody can tell whether the constraint is still real.',
    ).toBe(true);

    expect(
      /#\d{3,}/.test(why),
      'Running as root needs a tracking issue in the justification — the way out, ' +
        'not just the excuse.',
    ).toBe(true);

    // The three host-side constraints that actually force root. Naming them keeps
    // the comment falsifiable: whoever removes one can check it off here.
    const required: Array<[string, RegExp]> = [
      ['the bind-mounted podman socket', /podman\.sock/],
      ['the DATA_DIR bind mount', /\/app\/data/],
      ['the host SSH identity', /ssh/i],
    ];
    const missing = required.filter(([, re]) => !re.test(why)).map(([label]) => label);

    expect(
      missing,
      'The `USER root` justification must name the host-side constraints that force it, ' +
        `so a later reader can retest them. Missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
