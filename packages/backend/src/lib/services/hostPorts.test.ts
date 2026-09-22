/**
 * #3028 — the port map a session in a pod cannot see.
 *
 * Two properties carry the whole value, and both are places this would quietly
 * be wrong:
 *
 *  1. **Non-service listeners must appear.** The 2026-09-22 outage was
 *     `hostPort: 3000`, held by ServiceBay's own backend and by adguard.
 *     Neither is in a service listing, which is exactly why `services --json`
 *     was not the answer.
 *  2. **An empty list must never read as "everything is free."** That is the
 *     `ownershipSet: true` shape again: a reader that could not measure
 *     reporting availability.
 *
 * The `ss` parsing gets its own cases because an IPv6 address is full of
 * colons, and splitting on the first one turns `[::]:8080` into nonsense.
 */
import { describe, it, expect } from 'vitest';
import { parseSsLine, buildPortReport, suggestFreePorts } from './hostPorts';

describe('parseSsLine', () => {
  it('reads an ordinary IPv4 listener with its process', () => {
    expect(parseSsLine('tcp   LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("conmon",pid=123,fd=5))'))
      .toEqual({ port: 8080, protocol: 'tcp', address: '0.0.0.0', process: 'conmon' });
  });

  it('reads an IPv6 listener — the colons in the address must not be split on', () => {
    expect(parseSsLine('tcp LISTEN 0 4096 [::]:8080 [::]:* users:(("node",pid=9,fd=3))'))
      .toMatchObject({ port: 8080, address: '::', process: 'node' });
    expect(parseSsLine('tcp LISTEN 0 4096 [::1]:5888 [::]:*'))
      .toMatchObject({ port: 5888, address: '::1' });
  });

  it('keeps the bind address, so loopback can be told from world-facing', () => {
    expect(parseSsLine('tcp LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*')?.address).toBe('127.0.0.1');
  });

  it('reads udp as udp', () => {
    expect(parseSsLine('udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("adguard",pid=7,fd=8))'))
      .toMatchObject({ port: 53, protocol: 'udp', process: 'adguard' });
  });

  it('returns null for anything it cannot read, rather than a guess', () => {
    expect(parseSsLine('')).toBeNull();
    expect(parseSsLine('Netid State Recv-Q Send-Q Local Peer')).toBeNull();
    expect(parseSsLine('raw UNCONN 0 0 *:1 *:*')).toBeNull();
    expect(parseSsLine('tcp LISTEN 0 4096 0.0.0.0:notaport 0.0.0.0:*')).toBeNull();
    expect(parseSsLine('tcp LISTEN 0 4096 0.0.0.0:99999 0.0.0.0:*')).toBeNull();
  });
});

describe('buildPortReport', () => {
  const listening = [
    { port: 8096, protocol: 'tcp' as const, address: '0.0.0.0', process: 'conmon' },
    { port: 3000, protocol: 'tcp' as const, address: '0.0.0.0', process: 'node' },
    { port: 5888, protocol: 'tcp' as const, address: '0.0.0.0', process: 'node' },
    { port: 22, protocol: 'tcp' as const, address: '0.0.0.0', process: 'sshd' },
    { port: 53, protocol: 'udp' as const, address: '0.0.0.0', process: 'adguard' },
  ];
  const services = [{ name: 'media', ports: [{ host: '8096' }] }];

  it('names a service where one declares the port', () => {
    const r = buildPortReport('Local', listening, services);
    expect(r.ports.find(p => p.port === 8096)).toMatchObject({ owner: 'media', kind: 'service' });
  });

  it('names the CONTROL PLANE for 3000 and 5888 — the 2026-09-22 case', () => {
    const r = buildPortReport('Local', listening, services);
    expect(r.ports.find(p => p.port === 3000)).toMatchObject({ kind: 'control-plane' });
    expect(r.ports.find(p => p.port === 3000)?.owner).toContain('servicebay');
    expect(r.ports.find(p => p.port === 5888)?.kind).toBe('control-plane');
  });

  it('shows what is NOT a ServiceBay service — the whole reason a service listing is not enough', () => {
    const r = buildPortReport('Local', listening, services);
    expect(r.ports.find(p => p.port === 22)).toMatchObject({ owner: 'sshd', kind: 'other' });
    expect(r.ports.find(p => p.port === 53)).toMatchObject({ owner: 'adguard', kind: 'other', protocol: 'udp' });
    expect(r.summary).toContain('NOT a ServiceBay service');
  });

  it('a declared service port that nothing is listening on is still TAKEN', () => {
    // An installed service owns its port whether or not it runs (#2994).
    // Offering it as free would walk straight into a collision refusal.
    const r = buildPortReport('Local', listening, [...services, { name: 'stopped-thing', ports: [{ host: 8091 }] }]);
    expect(r.ports.find(p => p.port === 8091)).toMatchObject({ owner: 'stopped-thing', kind: 'service' });
    expect(r.free).not.toContain(8091);
  });

  it('suggests free ports that are actually free', () => {
    const r = buildPortReport('Local', [...listening, { port: 8090, protocol: 'tcp', address: '0.0.0.0' }], services);
    expect(r.free).not.toContain(8090);
    expect(r.free[0]).toBe(8091);
    for (const f of r.free) expect(r.ports.some(p => p.port === f)).toBe(false);
  });

  it('a table that could NOT be read is its own answer, with no free ports offered', () => {
    // `null` ≠ `[]`. The declared service ports alone are not a port map: they
    // miss sshd, adguard and the control plane — the three that caused the
    // outages. Offering suggestions from half a map is worse than refusing to.
    const r = buildPortReport('Local', null, [{ name: 'media', ports: [{ host: '8096' }] }]);
    expect(r.ports).toEqual([]);
    expect(r.free).toEqual([]);
    expect(r.summary).toContain('Do not read an empty list');
    expect(r.summary).toContain('not in any service listing');
  });

  it('a genuinely empty box is reported as unusual, not as a failure', () => {
    const r = buildPortReport('Local', [], []);
    expect(r.summary).toContain('unusual');
    expect(r.summary).not.toContain('Do not read an empty list');
  });

  it('reports a port once per protocol, keeping tcp and udp apart', () => {
    const r = buildPortReport('Local', [
      { port: 53, protocol: 'tcp', address: '0.0.0.0', process: 'adguard' },
      { port: 53, protocol: 'udp', address: '0.0.0.0', process: 'adguard' },
      { port: 53, protocol: 'udp', address: '127.0.0.1', process: 'adguard' },
    ], []);
    expect(r.ports.filter(p => p.port === 53)).toHaveLength(2);
  });

  it('falls back to `unknown` rather than inventing an owner', () => {
    const r = buildPortReport('Local', [{ port: 9999, protocol: 'tcp', address: '0.0.0.0' }], []);
    expect(r.ports[0].owner).toBe('unknown');
  });
});

describe('suggestFreePorts', () => {
  it('skips what is taken', () => {
    expect(suggestFreePorts([8090, 8091], 2)).toEqual([8092, 8093]);
  });

  it('never suggests a privileged port', () => {
    for (const p of suggestFreePorts([], 5)) expect(p).toBeGreaterThan(1024);
  });
});
