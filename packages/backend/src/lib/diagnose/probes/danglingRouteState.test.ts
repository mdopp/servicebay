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
