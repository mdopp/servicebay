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
 * issue that tracks the way out — why not. The image runs unprivileged again as
 * of #2815, so the root branch of that rule is currently dormant; it is kept
 * deliberately, because a rollback to root is a legitimate move (#2805 was one)
 * and must come back with its reasoning attached rather than silently.
 *
 * The second describe block below is the #2789 half. Its one assertion about the
 * active user has moved twice — to root in #2805 when the unprivileged image
 * came up on a mapping-less quadlet, and back to `nextjs` in #2815 once the
 * host-side reconcile of #2808 had shipped a release earlier and was confirmed
 * on the box. Every other assertion in the block held through both flips,
 * because it pins the *shape* the image must keep — the uid/gid pair the
 * reconciler copies into each box's quadlet, `--chown` on every runner COPY, no
 * privileged step below the switch, no ENV into /root. Nothing else in the repo
 * can catch a regression here: the image is only built at release time, so a
 * wrong uid surfaces as a dead box, not as a red test.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';

import { USERNS_SELFHEAL_SCRIPT } from '../../packages/backend/src/lib/quadletUserNsHostHook';

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

  it('runs unprivileged — the #2815 re-land, one release after the host half', () => {
    // The non-root image only survives with `UserNS=keep-id:uid=1001,gid=1001`
    // on servicebay.container. #2789 shipped it in 5.28.0 while the only writer
    // of that line was in-app, and the host's podman-auto-update.timer runs
    // nowhere near the app: it pulls :latest and restarts the unit with no
    // pre-swap hook, so the container came up mapping-less and lost /app/data,
    // the agent key and the podman socket (#2805). #2808 landed the host half —
    // the plain ExecStartPre self-heal, asserted by the cross-check block below
    // — and shipped it in 5.29.0; #2815 flips this line one release later, which
    // is the ordering the halves require (the host half is delivered to existing
    // boxes by the RUNNING app, so it must already be there when the new image
    // arrives). Going back is safe in the same way: both reconciles remove a
    // stray `UserNS=` under a root image.
    const active = lines().filter((l) => /^\s*USER\s+\S/.test(l));
    expect(active.map((l) => l.trim())).toEqual(['USER nextjs']);
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

/**
 * The image half and the host half must be un-releasable apart (#2808).
 *
 * #2805 is the shape this block exists to stop: `USER nextjs` shipped in 5.28.0
 * while the only thing that writes `UserNS=` onto a box ran nowhere near the
 * delivery path that installs it (`podman-auto-update.timer`, host-side, no
 * in-app hook). CI was green, every test passed, and the box lost its podman
 * socket, its DATA_DIR and its agent key the moment the timer fired. Nothing in
 * the repo could have caught it, because no test related the Dockerfile's
 * `USER` to what ships on the host.
 *
 * So the pairing is now a *rule*, evaluated over both halves at once:
 *
 *   image runs as root      → nothing is owed. Root is the self-healing state:
 *                             the reconciler strips a stray mapping.
 *   image declares uid N≠0  → the host-side self-heal must ship in the butane
 *                             template AND be wired into servicebay.container's
 *                             [Service] without a leading `-`, and its uid must
 *                             be derived (or agree with the image's `useradd`).
 *
 * `crossCheck` is deliberately a pure function of both halves, so the negative
 * direction is testable: a synthetic "USER nextjs + host half missing" must come
 * back with violations. A test that only asserted today's repo state would go
 * green on exactly the release that breaks the box.
 */
describe('image ↔ quadlet cross-check (#2808)', () => {
  const BUTANE = path.join(REPO_ROOT, 'tools', 'sb', 'internal', 'build', 'assets', 'fedora-coreos.bu');
  const SELFHEAL_PATH = '/usr/local/bin/servicebay-userns-selfheal.sh';

  interface HostHalf {
    /** The self-heal script's text as it ships in the butane template, or null. */
    script: string | null;
    /** servicebay.container's `[Service]` wires it, without a leading `-`. */
    wired: boolean;
  }

  /** Everything the rule needs from the image half. */
  interface ImageHalf {
    /** The active `USER` directive's argument. */
    user: string;
    /** uid/gid from the runner stage's `useradd`/`groupadd`, when it declares them. */
    uid: number | null;
    gid: number | null;
  }

  /** The pairing rule. Returns one string per violation; empty = the halves agree. */
  function crossCheck(image: ImageHalf, host: HostHalf): string[] {
    const bad: string[] = [];
    if (image.user === 'root' || image.user === '0') return bad;

    if (host.script === null) {
      bad.push(
        `the image declares \`USER ${image.user}\` but no host-side UserNS reconcile ships at ` +
          `${SELFHEAL_PATH} — the podman-auto-update path would start it on a mapping-less quadlet (#2805)`,
      );
      return bad;
    }
    if (!host.wired) {
      bad.push(
        `${SELFHEAL_PATH} ships but servicebay.container does not run it as a plain ` +
          '`ExecStartPre=` — an unwired (or `-`-prefixed) hook cannot abort the stale start',
      );
    }
    const hardCoded = [...host.script.matchAll(/keep-id:uid=(\d+),gid=(\d+)/g)];
    for (const [, uid, gid] of hardCoded) {
      if (image.uid !== null && Number(uid) !== image.uid) {
        bad.push(`the host half hard-codes uid ${uid}; the image's useradd says ${image.uid}`);
      }
      if (image.gid !== null && Number(gid) !== image.gid) {
        bad.push(`the host half hard-codes gid ${gid}; the image's groupadd says ${image.gid}`);
      }
    }
    return bad;
  }

  /** Butane is YAML with column-0 `${VAR}` placeholders that break block scalars. */
  function butaneFiles(): Array<{ path: string; contents?: { inline?: string } }> {
    const text = fs
      .readFileSync(BUTANE, 'utf8')
      .replace(/^\$\{[A-Z_]+\}[ \t]*$/gm, '          "STUBBED_INTERPOLATION"');
    const doc = yaml.load(text) as { storage?: { files?: Array<{ path: string; contents?: { inline?: string } }> } };
    return doc?.storage?.files ?? [];
  }

  function realHostHalf(): HostHalf {
    const files = butaneFiles();
    const script = files.find((f) => f.path === SELFHEAL_PATH)?.contents?.inline ?? null;
    const quadlet =
      files.find((f) => f.path.endsWith('/.config/containers/systemd/servicebay.container'))?.contents?.inline ?? '';
    const wired = quadlet
      .split('\n')
      .some((l) => l.trim() === `ExecStartPre=/bin/bash ${SELFHEAL_PATH}`);
    return { script, wired };
  }

  function realImageHalf(): ImageHalf {
    const all = lines();
    const user = all.find((l) => /^\s*USER\s+\S/.test(l))!.trim().replace(/^USER\s+/, '');
    const stage = all.join('\n');
    const uid = /useradd\s+--system\s+--uid\s+(\d+)/.exec(stage);
    const gid = /groupadd\s+--system\s+--gid\s+(\d+)/.exec(stage);
    return { user, uid: uid ? Number(uid[1]) : null, gid: gid ? Number(gid[1]) : null };
  }

  it('the repo as it stands satisfies the pairing rule', () => {
    expect(crossCheck(realImageHalf(), realHostHalf())).toEqual([]);
  });

  it('FAILS for `USER nextjs` with the host half absent — the #2805 release', () => {
    const bad = crossCheck({ user: 'nextjs', uid: 1001, gid: 1001 }, { script: null, wired: false });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain(SELFHEAL_PATH);
  });

  it('FAILS for `USER nextjs` when the script ships but nothing runs it', () => {
    const bad = crossCheck({ user: 'nextjs', uid: 1001, gid: 1001 }, { script: '#!/bin/bash\nexit 0\n', wired: false });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('ExecStartPre');
  });

  it('FAILS when the host half hard-codes a uid the image does not use', () => {
    const bad = crossCheck(
      { user: 'nextjs', uid: 1001, gid: 1001 },
      { script: 'UserNS=keep-id:uid=1000,gid=1000\n', wired: true },
    );
    expect(bad).toEqual([
      "the host half hard-codes uid 1000; the image's useradd says 1001",
      "the host half hard-codes gid 1000; the image's groupadd says 1001",
    ]);
  });

  it('PASSES for `USER nextjs` against the host half this repo actually ships', () => {
    // The re-land gate: the day the Dockerfile flips, this must already be green.
    expect(crossCheck({ user: 'nextjs', uid: 1001, gid: 1001 }, realHostHalf())).toEqual([]);
  });

  it('owes nothing while the image runs as root', () => {
    expect(crossCheck({ user: 'root', uid: 1001, gid: 1001 }, { script: null, wired: false })).toEqual([]);
  });

  it('ships exactly one copy of the self-heal script, generated from the backend module', () => {
    // Two divergent copies of the same reconcile is how the halves drift apart
    // again: Ignition writes this one, the running app pushes the module's to
    // boxes installed before #2808.
    expect(realHostHalf().script).toBe(USERNS_SELFHEAL_SCRIPT);
  });

  it('keeps `UserNS=` out of the butane quadlet — it is derived, never templated', () => {
    const quadlet =
      butaneFiles().find((f) => f.path.endsWith('/.config/containers/systemd/servicebay.container'))?.contents
        ?.inline ?? '';
    expect(quadlet.split('\n').filter((l) => /^\s*UserNS\s*=/.test(l))).toEqual([]);
  });
});
