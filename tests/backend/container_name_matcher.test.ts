/**
 * Unit tests for the container-name matcher lifted out of
 * ServiceManager.listServices (#589). Exercises every strategy
 * (simple / systemd / pod / YAML-derived) plus the picker's
 * port-priority + leading-slash tolerance.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExpectedContainerNames,
  pickContainerForService,
  type PodLikeDoc,
} from '@/lib/services/containerNameMatcher';
import type { EnrichedContainer } from '@/lib/agent/types';

describe('buildExpectedContainerNames (#589)', () => {
  it('returns the three systemd-style candidates with no YAML', () => {
    expect(buildExpectedContainerNames('immich')).toEqual([
      'immich',
      'systemd-immich',
      'immich-immich',
    ]);
  });

  it('adds pod and container names from Pod YAML', () => {
    const docs: PodLikeDoc[] = [{
      metadata: { name: 'mypod' },
      spec: { containers: [{ name: 'server' }, { name: 'ml' }] },
    }];
    const names = buildExpectedContainerNames('immich', docs);
    expect(names).toContain('mypod');
    expect(names).toContain('server');
    expect(names).toContain('ml');
    expect(names).toContain('immich-server');
    expect(names).toContain('mypod-server');
    expect(names).toContain('immich-ml');
    expect(names).toContain('mypod-ml');
  });

  it('deduplicates and preserves insertion order', () => {
    const docs: PodLikeDoc[] = [{
      metadata: { name: 'immich' }, // collides with baseName
      spec: { containers: [{ name: 'immich' }] },
    }];
    const names = buildExpectedContainerNames('immich', docs);
    const seen = new Set<string>();
    for (const n of names) {
      expect(seen.has(n), `dup ${n}`).toBe(false);
      seen.add(n);
    }
    expect(names[0]).toBe('immich'); // simple form stays first
  });

  it('ignores YAML docs with no containers section', () => {
    const docs: PodLikeDoc[] = [{ metadata: { name: 'irrelevant' } }];
    const names = buildExpectedContainerNames('app', docs);
    expect(names).toEqual(['app', 'systemd-app', 'app-app', 'irrelevant']);
  });
});

describe('pickContainerForService (#589)', () => {
  const mk = (names: string[], ports?: EnrichedContainer['ports']): EnrichedContainer => ({
    Id: names[0],
    State: 'running',
    names,
    ports,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  it('returns undefined when no container name matches', () => {
    const containers = [mk(['other'])];
    expect(pickContainerForService(containers, ['immich'])).toBeUndefined();
  });

  it('strips Podman leading slash when matching', () => {
    const containers = [mk(['/immich'])];
    expect(pickContainerForService(containers, ['immich'])).toBe(containers[0]);
  });

  it('prefers a port-bearing container over a portless match', () => {
    const portless = mk(['/immich']);
    const withPorts = mk(['/systemd-immich'], [{ containerPort: 8080, protocol: 'tcp', hostPort: 8080 }]);
    const out = pickContainerForService([portless, withPorts], ['immich', 'systemd-immich']);
    expect(out).toBe(withPorts);
  });

  it('falls back to the first match when none have ports', () => {
    const a = mk(['/immich']);
    const b = mk(['/systemd-immich']);
    expect(pickContainerForService([a, b], ['immich', 'systemd-immich'])).toBe(a);
  });
});
