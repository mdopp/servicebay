import { describe, it, expect } from 'vitest';
import {
  classifyDanglingRoute,
  forwardHostForPort,
  describeRouteVerdict,
  actionIdsForVerdict,
  buildRouteItem,
  tallyRouteStates,
  formatRouteStateDetail,
  formatRouteStateHint,
  type RouteOwner,
  type RouteTargetService,
} from './danglingRouteState';

// The live shape this issue was filed from (#2611): daggerheart-chronik
// republished on 8701 on 2026-08-23; daggerheart.dopp.cloud stayed on
// 8700 and the probe offered "Delete route".
const OWNERS: RouteOwner[] = [
  { domain: 'daggerheart.dopp.cloud', service: 'daggerheart-chronik' },
  { domain: 'home.dopp.cloud', service: 'home-assistant' },
  { domain: 'old.dopp.cloud', service: 'retired-thing' },
];

const SERVICES: RouteTargetService[] = [
  {
    name: 'daggerheart-chronik',
    ports: [{ hostPort: 8701, containerPort: 8701, protocol: 'tcp', hostIp: '192.168.178.100' }],
  },
  {
    name: 'home-assistant',
    ports: [
      { hostPort: 8123, containerPort: 8123, protocol: 'tcp', hostIp: '192.168.178.100' },
      { hostPort: 8091, containerPort: 8091, protocol: 'tcp', hostIp: '192.168.178.100' },
      { hostPort: 1900, containerPort: 1900, protocol: 'udp', hostIp: '192.168.178.100' },
    ],
  },
];

const DAGGERHEART = {
  domain: 'daggerheart.dopp.cloud',
  targetHost: '192.168.178.100',
  targetPort: 8700,
};

describe('classifyDanglingRoute', () => {
  it('calls the live-service-on-another-port case a port move, not a dead route', () => {
    const verdict = classifyDanglingRoute(DAGGERHEART, OWNERS, SERVICES);
    expect(verdict).toEqual({
      kind: 'port-moved',
      service: 'daggerheart-chronik',
      to: 8701,
      forwardHost: '192.168.178.100',
    });
    expect(actionIdsForVerdict(verdict)).toEqual(['repoint_route']);
    expect(actionIdsForVerdict(verdict)).not.toContain('delete_route');
  });

  it('still calls a route whose service no longer exists gone, and still offers deletion', () => {
    const verdict = classifyDanglingRoute(
      { domain: 'old.dopp.cloud', targetHost: '192.168.178.100', targetPort: 9999 },
      OWNERS,
      SERVICES,
    );
    expect(verdict).toEqual({ kind: 'target-gone', service: 'retired-thing' });
    expect(actionIdsForVerdict(verdict)).toEqual(['delete_route']);
  });

  it('treats a domain with no recorded owner as gone — nothing links it to a service', () => {
    const verdict = classifyDanglingRoute(
      { domain: 'handmade.dopp.cloud', targetHost: '192.168.178.100', targetPort: 4444 },
      OWNERS,
      SERVICES,
    );
    expect(verdict).toEqual({ kind: 'target-gone' });
    expect(actionIdsForVerdict(verdict)).toEqual(['delete_route']);
  });

  it('separates a service that exists but publishes nothing from one that is gone', () => {
    const stopped: RouteTargetService[] = [{ name: 'daggerheart-chronik', ports: [] }];
    const verdict = classifyDanglingRoute(DAGGERHEART, OWNERS, stopped);
    expect(verdict).toEqual({ kind: 'service-silent', service: 'daggerheart-chronik' });
  });

  it('refuses to guess when a live service publishes several plausible ports', () => {
    const verdict = classifyDanglingRoute(
      { domain: 'home.dopp.cloud', targetHost: '192.168.178.100', targetPort: 8124 },
      OWNERS,
      SERVICES,
    );
    expect(verdict).toEqual({ kind: 'port-ambiguous', service: 'home-assistant', candidates: [8091, 8123] });
    // No fix at all beats a fix that sends a live domain somewhere wrong
    // — and "delete" is still not the answer while the service is up.
    expect(actionIdsForVerdict(verdict)).toEqual([]);
  });

  it('resolves a multi-port service when the container port is unchanged and only the host mapping moved', () => {
    const bumped: RouteTargetService[] = [{
      name: 'home-assistant',
      ports: [
        { hostPort: 18123, containerPort: 8123, protocol: 'tcp' },
        { hostPort: 8091, containerPort: 8091, protocol: 'tcp' },
      ],
    }];
    const verdict = classifyDanglingRoute(
      { domain: 'home.dopp.cloud', targetHost: '192.168.178.100', targetPort: 8123 },
      OWNERS,
      bumped,
    );
    expect(verdict).toEqual({ kind: 'port-moved', service: 'home-assistant', to: 18123, forwardHost: undefined });
  });

  it('never repoints onto a UDP publish', () => {
    const udpOnly: RouteTargetService[] = [{
      name: 'daggerheart-chronik',
      ports: [{ hostPort: 8701, containerPort: 8701, protocol: 'udp' }],
    }];
    expect(classifyDanglingRoute(DAGGERHEART, OWNERS, udpOnly))
      .toEqual({ kind: 'service-silent', service: 'daggerheart-chronik' });
  });

  it('matches the recorded domain case-insensitively', () => {
    const verdict = classifyDanglingRoute(
      { ...DAGGERHEART, domain: 'DAGGERHEART.dopp.cloud' },
      OWNERS,
      SERVICES,
    );
    expect(verdict.kind).toBe('port-moved');
  });

  // #2860 — the ollama.dopp.cloud shape: the container was removed on
  // 2026-09-06 but `ollama.container` survived the delete, so the twin
  // still lists the service AND its declared 11434 publish while nothing
  // has the port open.
  const OLLAMA_OWNERS: RouteOwner[] = [{ domain: 'ollama.dopp.cloud', service: 'ollama' }];
  const OLLAMA_SERVICES: RouteTargetService[] = [{
    name: 'ollama',
    ports: [{ hostPort: 11434, containerPort: 11434, protocol: 'tcp', hostIp: '127.0.0.1' }],
  }];
  const OLLAMA_ROUTE = { domain: 'ollama.dopp.cloud', targetHost: '127.0.0.1', targetPort: 11434 };

  it('calls a route dangling when its forward port has no listener, service entry or not', () => {
    const verdict = classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: false }, OLLAMA_OWNERS, OLLAMA_SERVICES);
    expect(verdict).toEqual({ kind: 'no-listener', service: 'ollama' });
    expect(actionIdsForVerdict(verdict)).toEqual(['delete_route']);
  });

  it('names the check that failed — the closed port, not the missing service', () => {
    const item = buildRouteItem(
      { ...OLLAMA_ROUTE, listening: false },
      classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: false }, OLLAMA_OWNERS, OLLAMA_SERVICES),
    );
    expect(item.detail).toContain('no listener on 127.0.0.1:11434');
    expect(item.detail).toContain('ollama');
    expect(item.detail).not.toContain('no service');
  });

  it('keeps "service gone" as its own reason when the service really is gone', () => {
    const verdict = classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: false }, OLLAMA_OWNERS, []);
    // An empty service list is the caller's "twin not populated" case, so
    // use a populated one that simply has no `ollama` in it.
    const gone = classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: false }, OLLAMA_OWNERS, SERVICES);
    expect(verdict.kind).toBe('target-gone');
    expect(gone).toEqual({ kind: 'target-gone', service: 'ollama' });
    expect(describeRouteVerdict(OLLAMA_ROUTE, gone)).toContain('no service called ollama');
    expect(actionIdsForVerdict(gone)).toEqual(['delete_route']);
  });

  it('leaves a route alone when both checks are fine', () => {
    // Listener present and the service publishes the very port the route
    // forwards to: `service-silent` stays `service-silent`, and the run
    // never classifies such a route in the first place.
    const verdict = classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: true }, OLLAMA_OWNERS, OLLAMA_SERVICES);
    expect(verdict).toEqual({ kind: 'service-silent', service: 'ollama' });
  });

  it('leaves a merely stopped service at "silent" — a closed port is not proof of an orphan', () => {
    // #2611's guard survives #2860: the record publishes nothing at all,
    // so the port being closed says "stopped", not "the entry is stale".
    const stopped: RouteTargetService[] = [{ name: 'ollama', ports: [] }];
    const verdict = classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: false }, OLLAMA_OWNERS, stopped);
    expect(verdict).toEqual({ kind: 'service-silent', service: 'ollama' });
  });

  it('will not read an unavailable listener snapshot as a closed port', () => {
    const verdict = classifyDanglingRoute({ ...OLLAMA_ROUTE, listening: undefined }, OLLAMA_OWNERS, OLLAMA_SERVICES);
    expect(verdict.kind).toBe('service-silent');
  });

  it('still prefers a repoint over "no listener" when the service moved port', () => {
    // The old port is closed — that is what a moved publish looks like —
    // but the service is alive on 8701, so deleting is still wrong.
    const verdict = classifyDanglingRoute({ ...DAGGERHEART, listening: false }, OWNERS, SERVICES);
    expect(verdict.kind).toBe('port-moved');
    expect(actionIdsForVerdict(verdict)).toEqual(['repoint_route']);
  });

  it('has no verdict beyond "gone" for an unnamed server block', () => {
    const verdict = classifyDanglingRoute({ targetHost: '192.168.178.100', targetPort: 7000 }, OWNERS, SERVICES);
    expect(verdict).toEqual({ kind: 'target-gone' });
  });
});

describe('forwardHostForPort', () => {
  it('keeps the current forward host for a wildcard bind', () => {
    expect(forwardHostForPort(undefined)).toBeUndefined();
    expect(forwardHostForPort('0.0.0.0')).toBeUndefined();
    expect(forwardHostForPort('')).toBeUndefined();
  });

  it('normalises a loopback-only publish to 127.0.0.1, as buildProxyHosts does', () => {
    expect(forwardHostForPort('127.0.0.1')).toBe('127.0.0.1');
    expect(forwardHostForPort('localhost')).toBe('127.0.0.1');
    expect(forwardHostForPort('::1')).toBe('127.0.0.1');
  });

  it('uses a specific LAN bind verbatim', () => {
    expect(forwardHostForPort('192.168.178.100')).toBe('192.168.178.100');
  });
});

describe('buildRouteItem', () => {
  it('names the running service and both ports so the row explains itself', () => {
    const item = buildRouteItem(DAGGERHEART, classifyDanglingRoute(DAGGERHEART, OWNERS, SERVICES));
    expect(item.id).toBe('daggerheart.dopp.cloud');
    expect(item.detail).toContain('daggerheart-chronik is running and publishes 8701, not 8700');
    expect(item.actionIds).toEqual(['repoint_route']);
  });

  it('leaves an unnamed server block read-only — there is no id to dispatch against', () => {
    const route = { targetHost: '192.168.178.100', targetPort: 7000 };
    const item = buildRouteItem(route, classifyDanglingRoute(route, OWNERS, SERVICES));
    expect(item.id).toBe('unnamed-192.168.178.100-7000');
    expect(item.actionIds).toEqual([]);
  });

  it('describes a silent service as fixable on the service, not by deleting the domain', () => {
    expect(describeRouteVerdict(DAGGERHEART, { kind: 'service-silent', service: 'x' }))
      .toContain('publishes no port right now');
  });
});

describe('formatRouteStateDetail', () => {
  it('leads with the denominator so one bad route cannot read as everything', () => {
    const tally = tallyRouteStates(22, [{ kind: 'port-moved', service: 'daggerheart-chronik', to: 8701 }], 0);
    expect(formatRouteStateDetail(tally))
      .toBe('22 proxy routes: 1 of 22 point at a port their service no longer publishes.');
  });

  it('states the clean case with its denominator too', () => {
    expect(formatRouteStateDetail(tallyRouteStates(22, [], 0)))
      .toBe('22 proxy routes, all reaching a port their service publishes.');
  });

  it('keeps the states separate instead of collapsing them into one count', () => {
    const tally = tallyRouteStates(
      10,
      [
        { kind: 'port-moved', service: 'a', to: 1 },
        { kind: 'target-gone', service: 'b' },
        { kind: 'service-silent', service: 'c' },
      ],
      2,
    );
    const detail = formatRouteStateDetail(tally);
    expect(detail).toContain('1 of 10 point at a port their service no longer publishes');
    expect(detail).toContain('1 of 10 point at a service that publishes nothing right now');
    expect(detail).toContain('1 of 10 point at a service that is gone');
    expect(detail).toContain('2 recorded routes never got created in NPM');
  });

  it('counts a closed forward port separately from a gone service', () => {
    const tally = tallyRouteStates(
      29,
      [{ kind: 'no-listener', service: 'ollama' }, { kind: 'target-gone', service: 'tor' }],
      0,
    );
    expect(tally.noListener).toBe(1);
    expect(tally.gone).toBe(1);
    const detail = formatRouteStateDetail(tally);
    expect(detail).toContain('1 of 29 forward to a port nothing is listening on');
    expect(detail).toContain('1 of 29 point at a service that is gone');
    expect(formatRouteStateHint(tally)).toContain('Delete route');
  });

  it('counts an ambiguous route as a wrong port, not as a gone target', () => {
    const tally = tallyRouteStates(5, [{ kind: 'port-ambiguous', service: 'a', candidates: [1, 2] }], 0);
    expect(tally.gone).toBe(0);
    expect(formatRouteStateDetail(tally)).toContain('1 of 5 point at a port their service no longer publishes');
  });
});

describe('formatRouteStateHint', () => {
  it('warns against deleting a moved route instead of just listing the buttons', () => {
    const hint = formatRouteStateHint(tallyRouteStates(3, [{ kind: 'port-moved', service: 'a', to: 1 }], 0));
    expect(hint).toContain('Repoint route');
    expect(hint).toContain('certificate');
    expect(hint).not.toContain('Delete route');
  });

  it('mentions only the fixes that are actually on screen', () => {
    const hint = formatRouteStateHint(tallyRouteStates(3, [{ kind: 'target-gone' }], 0));
    expect(hint).toContain('Delete route');
    expect(hint).not.toContain('Repoint route');
    expect(hint).not.toContain('Retry create');
  });

  it('says nothing when nothing is wrong', () => {
    expect(formatRouteStateHint(tallyRouteStates(3, [], 0))).toBeUndefined();
  });
});
