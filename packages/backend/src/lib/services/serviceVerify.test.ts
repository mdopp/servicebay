/**
 * #3021 — what "deployment done" is allowed to mean.
 *
 * Every check here has four verdicts, and the two extra ones are the point. A
 * verification tool that only knows `ok` and `problem` has to file everything
 * it could not measure under one of them, and both choices are lies this repo
 * has already paid for:
 *
 *   - calling it `ok` is the `ownershipSet: true` shape (#2996) — success
 *     reported for something never checked;
 *   - calling it `problem` is what #3020 refuses to do — blocking on our own
 *     blindness.
 *
 * So `unknown` is reported and counted, and `skipped` means there was genuinely
 * nothing to measure. Only `problem` makes the report not-ok.
 */
import { describe, it, expect } from 'vitest';
import {
  checkHealth,
  checkRestarts,
  checkImage,
  checkManifest,
  checkProxyRoute,
  checkPublicUrl,
  buildReport,
  type ContainerState,
} from './serviceVerify';

const container = (over: Partial<ContainerState> = {}): ContainerState => ({
  name: 'asteroids-web',
  status: 'Up 2 hours',
  restartCount: 0,
  ...over,
});

describe('checkHealth', () => {
  it('green is ok, and shows what it read', () => {
    const c = checkHealth([container({ health: { status: 'healthy' } })]);
    expect(c.status).toBe('ok');
    expect(c.measured).toContain('healthy');
  });

  it('a service with no health check is SKIPPED, not passed', () => {
    expect(checkHealth([container()]).status).toBe('skipped');
  });

  it('unhealthy is a problem and carries the last health-log line — the part that says why', () => {
    const c = checkHealth([container({ health: { status: 'unhealthy', failingStreak: 12, lastOutput: 'sh: curl: not found' } })]);
    expect(c.status).toBe('problem');
    expect(c.measured).toContain('failing 12');
    expect(c.detail).toContain('sh: curl: not found');
  });

  it('"starting" is UNKNOWN — a check inside its start period has not failed yet', () => {
    const c = checkHealth([container({ health: { status: 'starting' } })]);
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain('Measure again');
  });

  it('no containers at all is unknown, and says the service may not have started', () => {
    const c = checkHealth([]);
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain('servicebay logs');
  });
});

describe('checkRestarts', () => {
  it('a quiet container is ok', () => {
    expect(checkRestarts([container()]).status).toBe('ok');
  });

  it('a restarting container is a problem, and points at the logs', () => {
    const c = checkRestarts([container({ status: 'Restarting (1) 3 seconds ago', restartCount: 47 })]);
    expect(c.status).toBe('problem');
    expect(c.detail).toContain('servicebay logs');
    expect(c.measured).toContain('47 restart');
  });

  it('a HIGH LIFETIME count on a long-stable container is not a loop', () => {
    // The solaris-tts-bridge false positive the diagnose kernel already solved:
    // RestartCount is cumulative, so a container up for 44 hours is not looping
    // now. Re-deriving that here instead of reusing the rule would reintroduce
    // it.
    const c = checkRestarts([container({ status: 'Up 44 hours', restartCount: 24 })]);
    expect(c.status).toBe('ok');
  });

  it('a freshly-restarted container with a high count IS a loop', () => {
    const c = checkRestarts([container({ status: 'Up 3 seconds', restartCount: 1006 })]);
    expect(c.status).toBe('problem');
  });
});

describe('psStatusFrom — the translation that makes the restart rule work', () => {
  it('a container started seconds ago reads as young, not as long-stable', async () => {
    const { psStatusFrom } = await import('./serviceVerifyRun');
    const now = Date.parse('2026-09-21T20:00:00Z');
    expect(psStatusFrom('running', '2026-09-21T19:59:57Z', now)).toBe('Up 3 seconds');
  });

  it('a container up for hours reads as hours', async () => {
    const { psStatusFrom } = await import('./serviceVerifyRun');
    const now = Date.parse('2026-09-21T20:00:00Z');
    expect(psStatusFrom('running', '2026-09-21T16:00:00Z', now)).toBe('Up 4 hours');
  });

  it('restarting translates to the string the rule recognises', async () => {
    const { psStatusFrom } = await import('./serviceVerifyRun');
    expect(psStatusFrom('restarting', undefined)).toMatch(/^Restarting/);
  });

  it('a freshly-restarted container with a LOW count is still caught', async () => {
    // Without the start time this reads as "Up 2 hours" and the loop goes
    // unreported — which is the case the check exists for.
    const { psStatusFrom } = await import('./serviceVerifyRun');
    const now = Date.parse('2026-09-21T20:00:00Z');
    const status = psStatusFrom('running', '2026-09-21T19:59:58Z', now);
    expect(checkRestarts([container({ status, restartCount: 2 })]).status).toBe('problem');
  });
});

describe('containerStateFrom — podman\'s real inspect shape', () => {
  const doc = (over: Record<string, unknown> = {}) => JSON.stringify([{
    RestartCount: 3,
    State: {
      Status: 'running',
      StartedAt: '2026-09-21T18:00:00Z',
      Health: {
        Status: 'unhealthy',
        FailingStreak: 12,
        Log: [
          { Output: 'first failure' },
          { Output: 'sh: curl: not found\n' },
        ],
      },
      ...(over.State as object ?? {}),
    },
    ...over,
  }]);

  it('takes the LAST health-log line — the earlier ones are history', async () => {
    const { containerStateFrom } = await import('./serviceVerifyRun');
    const c = containerStateFrom('asteroids-web', doc());
    expect(c.health?.lastOutput).toBe('sh: curl: not found');
    expect(c.health?.failingStreak).toBe(12);
    expect(c.restartCount).toBe(3);
    expect(c.startedAt).toBe('2026-09-21T18:00:00Z');
  });

  it('accepts the bare object as well as the array podman usually returns', async () => {
    const { containerStateFrom } = await import('./serviceVerifyRun');
    const bare = JSON.parse(doc())[0];
    expect(containerStateFrom('x', JSON.stringify(bare)).health?.status).toBe('unhealthy');
  });

  it('a container with no health check reports none rather than an empty one', async () => {
    const { containerStateFrom } = await import('./serviceVerifyRun');
    const c = containerStateFrom('x', JSON.stringify([{ RestartCount: 0, State: { Status: 'running' } }]));
    expect(c.health).toBeUndefined();
    // …and that is what makes the health check SKIPPED rather than failed.
    expect(checkHealth([c]).status).toBe('skipped');
  });

  it('an empty health log leaves the reason blank, not undefined-shaped', async () => {
    const { containerStateFrom } = await import('./serviceVerifyRun');
    const c = containerStateFrom('x', JSON.stringify([{ State: { Status: 'running', Health: { Status: 'healthy', Log: [] } } }]));
    expect(c.health?.lastOutput).toBe('');
  });
});

describe('checkImage', () => {
  const report = (over: Record<string, unknown> = {}, img: Record<string, unknown> = {}) => ({
    ok: true,
    summary: 'fine',
    images: [{ image: 'ghcr.io/mdopp/app:latest', published: true, upToDate: true, problem: null, ...img }],
    ...over,
  });

  it('published, current is ok', () => {
    expect(checkImage(report()).status).toBe('ok');
  });

  it('an unpublished image is a problem and relays the image report\'s own summary', () => {
    const c = checkImage(report({ ok: false, summary: 'The registry serves no such tag …' }, { published: false, problem: 'not-published' }));
    expect(c.status).toBe('problem');
    expect(c.measured).toContain('NOT PUBLISHED');
    expect(c.detail).toContain('no such tag');
  });

  it('behind the registry is a problem that names the verb which fixes it', () => {
    const c = checkImage(report({}, { upToDate: false }));
    expect(c.status).toBe('problem');
    expect(c.detail).toContain('servicebay update');
  });

  it('an unreadable local digest is UNKNOWN — "current" must not be claimed', () => {
    expect(checkImage(report({}, { upToDate: null })).status).toBe('unknown');
  });

  it('no image report at all is unknown, never ok', () => {
    expect(checkImage(null).status).toBe('unknown');
  });
});

describe('checkManifest', () => {
  it('an ordinary spec is ok and shows its size', () => {
    const c = checkManifest('apiVersion: v1\nkind: Pod\nmetadata: { name: x }\nspec: { containers: [{ name: web, image: a }] }\n');
    expect(c.status).toBe('ok');
    expect(c.measured).toContain('KB');
  });

  it('an embedded application is a problem', () => {
    const y = `apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: web
      image: a
      args: ["${'QUJDRA'.repeat(200)}"]
`;
    expect(checkManifest(y).status).toBe('problem');
  });

  it('a .container unit has no pod spec — skipped, not failed', () => {
    expect(checkManifest(null).status).toBe('skipped');
  });
});

describe('checkProxyRoute', () => {
  const routes = [{ host: 'asteroids.dopp.cloud', targetService: 'asteroids', targetPort: 8080 }];

  it('a route naming an installed service is ok', () => {
    expect(checkProxyRoute('asteroids', routes, ['asteroids', 'media']).status).toBe('ok');
  });

  it('no route at all is skipped', () => {
    expect(checkProxyRoute('media', [], ['media']).status).toBe('skipped');
  });

  it('a route naming a DELETED service is a problem, even while it appears to work', () => {
    // The real one: asteroids.dopp.cloud → "asteroids" while that service had
    // been gone a day. It only worked because another service held the port.
    const c = checkProxyRoute('asteroids', routes, ['media']);
    expect(c.status).toBe('problem');
    expect(c.measured).toContain('names no installed service');
    expect(c.detail).toContain('happens to hold');
  });
});

describe('checkPublicUrl', () => {
  it('2xx is ok', () => {
    expect(checkPublicUrl({ url: 'https://x.dopp.cloud', status: 200 }).status).toBe('ok');
  });

  it('a 401 from the SSO gate is a WORKING route, not a failure', () => {
    const c = checkPublicUrl({ url: 'https://x.dopp.cloud', status: 401 });
    expect(c.status).toBe('ok');
    expect(c.measured).toContain('SSO gate');
  });

  it('a 502 is a problem', () => {
    expect(checkPublicUrl({ url: 'https://x.dopp.cloud', status: 502 }).status).toBe('problem');
  });

  it('an unreachable URL is a problem and says the check ran from the BOX', () => {
    const c = checkPublicUrl({ url: 'https://x.dopp.cloud', error: 'getaddrinfo ENOTFOUND' });
    expect(c.status).toBe('problem');
    expect(c.detail).toContain('ADR 0007');
  });

  it('no public host is skipped', () => {
    expect(checkPublicUrl(null).status).toBe('skipped');
  });
});

describe('buildReport', () => {
  const ok = { id: 'health' as const, title: 'health', status: 'ok' as const, measured: 'healthy' };
  const problem = { id: 'restarts' as const, title: 'container is not restarting', status: 'problem' as const, measured: '47' };
  const unknown = { id: 'image' as const, title: 'image', status: 'unknown' as const, measured: '?' };
  const skipped = { id: 'proxy-route' as const, title: 'route', status: 'skipped' as const, measured: 'none' };

  it('all measurable checks passing is ok AND complete', () => {
    const r = buildReport('x', 'Local', [ok, skipped]);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.summary).toContain('every measurable check passed');
    // And it says what it still cannot see, rather than implying it covered it.
    expect(r.summary).toContain('browser');
  });

  it('an UNKNOWN keeps ok true but complete FALSE — and the summary refuses to call it done', () => {
    const r = buildReport('x', 'Local', [ok, unknown]);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.summary).toContain('not the same as passing');
    expect(r.summary).toContain('image');
  });

  it('a problem makes it not ok and names which check', () => {
    const r = buildReport('x', 'Local', [ok, problem]);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('NOT done');
    expect(r.summary).toContain('container is not restarting');
  });

  it('a skipped check never makes the report incomplete — there was nothing to measure', () => {
    expect(buildReport('x', 'Local', [skipped]).complete).toBe(true);
  });
});
