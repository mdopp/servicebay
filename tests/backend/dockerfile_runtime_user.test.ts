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
 * issue that tracks the way out — why not. `USER nextjs` landed in #2789 and was
 * rolled back in #2805, so the root branch applies again — which is exactly why
 * it was kept: a rollback to root is a legitimate move and must come back with
 * its reasoning attached.
 *
 * The second describe block below is the #2789 half. #2805 flipped its one
 * assertion about the active user (root, until the auto-update path reconciles
 * the quadlet mapping); every other assertion still holds and is deliberately
 * unchanged, because it pins the *shape* the image must keep for the re-land —
 * the uid/gid pair the reconciler copies into each box's quadlet, `--chown` on
 * every runner COPY, no privileged step below the switch, no ENV into /root.
 * Nothing else in the repo can catch a regression here: the image is only built
 * at release time, so a wrong uid surfaces as a dead box, not as a red test.
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

describe('Dockerfile unprivileged runtime (#2789)', () => {
  /** Lines of the runner stage only — the build stages legitimately run as root. */
  function runnerStage(): string[] {
    const all = lines();
    const start = all.findIndex((l) => /^FROM\s+\S+\s+AS\s+runner\s*$/.test(l));
    expect(start, 'no `FROM ... AS runner` stage in the Dockerfile').toBeGreaterThanOrEqual(0);
    return all.slice(start);
  }

  it('runs as root — the #2805 rollback, until the auto-update path reconciles', () => {
    // #2789 made this `USER nextjs`. The non-root image only survives with
    // `UserNS=keep-id:uid=1001,gid=1001` on servicebay.container, and that line
    // is written by a reconciler the host's podman-auto-update.timer never runs:
    // it pulls :latest and restarts the unit with no pre-swap hook, so 5.28.0
    // came up mapping-less and lost /app/data, the agent key and the podman
    // socket (#2805). Root is the self-healing state — the same timer repairs
    // the box, because quadletUserNs.ts strips a stray `UserNS=` under a root
    // image. Flip this back to `USER nextjs` only together with a host-side
    // reconcile on the auto-update path.
    const active = lines().filter((l) => /^\s*USER\s+\S/.test(l));
    expect(active.map((l) => l.trim())).toEqual(['USER root']);
  });

  it('creates nextjs as uid 1001 with nodejs (gid 1001) as its PRIMARY group', () => {
    // The quadlet reconciler (packages/backend/src/lib/quadletUserNs.ts) derives
    // `UserNS=keep-id:uid=<uid>,gid=<gid>` from `id` run inside this image and
    // writes it into every box's servicebay.container. Drop `--gid nodejs` and
    // useradd invents a primary group with an arbitrary free system gid —
    // silently, and only visible as a broken mapping on the box.
    const stage = runnerStage().join('\n');

    expect(stage, 'nodejs must be gid 1001').toMatch(/groupadd\s+--system\s+--gid\s+1001\s+nodejs\b/);
    expect(
      stage,
      'nextjs must be uid 1001 with an explicit `--gid nodejs`, or the uid/gid pair ' +
        'the #2788 reconciler bakes into the host quadlet is whatever useradd picked.',
    ).toMatch(/useradd\s+--system\s+--uid\s+1001\s+--gid\s+nodejs\b/);
  });

  it('gives the runtime user ownership of everything copied into /app', () => {
    // `chown -R /app` after the copies would work too, but duplicates ~1 GB of
    // node_modules/.next into a new layer — so ownership rides the COPYs.
    const unowned = runnerStage()
      .filter((l) => /^COPY\s+--from=/.test(l))
      .filter((l) => !/--chown=nextjs:nodejs\b/.test(l));

    expect(
      unowned,
      'Every COPY into the runner stage must carry `--chown=nextjs:nodejs`; a ' +
        'root-owned path under /app is unwritable to the runtime user.',
    ).toEqual([]);
  });

  it('keeps every privileged build step above the USER switch', () => {
    const stage = runnerStage();
    const at = stage.findIndex((l) => /^\s*USER\s+\S/.test(l));
    // Instructions only — a comment below the switch is free to *mention* chown.
    const after = stage
      .slice(at + 1)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

    const privileged = [/\bapt-get\b/, /\bgroupadd\b/, /\buseradd\b/, /\bchown\b/];
    const found = privileged.filter((re) => re.test(after)).map((re) => String(re));

    expect(
      found,
      'A step that needs root cannot sit below `USER nextjs` — it fails the image build.',
    ).toEqual([]);
  });

  it('points no runtime path at /root', () => {
    const rooty = runnerStage().filter((l) => /^\s*ENV\s/.test(l) && /(^|[=":\s])\/root\//.test(l));

    expect(
      rooty.map((l) => l.trim()),
      '/root is unreadable to the unprivileged runtime user, so a default that ' +
        'points there is a silent failure waiting for the first caller.',
    ).toEqual([]);
  });
});
