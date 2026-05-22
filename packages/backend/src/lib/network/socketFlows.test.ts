/**
 * Socket-flow discovery tests (#505).
 *
 * Covers the pure parsing + synthesis: `ss` row parsing, cgroup → PID
 * mapping, and the `resolveFlows` directed-edge synthesis.
 */
import { describe, it, expect } from 'vitest';
import {
  splitAddrPort,
  parseSsRows,
  parseCgroupMap,
  resolveFlows,
  type HostSockets,
} from './socketFlows';

describe('splitAddrPort', () => {
  it('parses plain IPv4', () => {
    expect(splitAddrPort('127.0.0.1:9091')).toEqual({ addr: '127.0.0.1', port: 9091 });
  });
  it('parses bracketed IPv6', () => {
    expect(splitAddrPort('[::1]:8080')).toEqual({ addr: '::1', port: 8080 });
  });
  it('parses v4-mapped IPv6 (port after the last colon)', () => {
    expect(splitAddrPort('::ffff:192.168.1.1:443')).toEqual({ addr: '::ffff:192.168.1.1', port: 443 });
  });
  it('returns null for the LISTEN wildcard peer `*:*`', () => {
    expect(splitAddrPort('*:*')).toBeNull();
  });
});

describe('parseSsRows', () => {
  const SAMPLE = [
    'LISTEN 0 4096 *:9091 *:* users:(("authelia",pid=1234,fd=8))',
    'ESTAB  0 0 192.168.178.100:54321 192.168.178.100:9091 users:(("media-abs",pid=2345,fd=12))',
    'ESTAB  0 0 [::1]:40100 [::1]:11434 users:(("ollama",pid=3456,fd=5))',
    'garbage line that should be skipped',
  ].join('\n');

  it('keeps LISTEN rows even though their peer is `*:*`', () => {
    const listen = parseSsRows(SAMPLE).find(r => r.state === 'LISTEN');
    expect(listen).toMatchObject({ state: 'LISTEN', localPort: 9091, pids: [1234] });
  });

  it('parses ESTAB rows with local/peer/pid', () => {
    const estab = parseSsRows(SAMPLE).filter(r => r.state === 'ESTAB');
    expect(estab).toHaveLength(2);
    expect(estab[0]).toMatchObject({ peerAddr: '192.168.178.100', peerPort: 9091, pids: [2345] });
    expect(estab[1]).toMatchObject({ peerPort: 11434, pids: [3456] });
  });

  it('skips unparseable lines', () => {
    expect(parseSsRows(SAMPLE)).toHaveLength(3);
  });
});

describe('parseCgroupMap', () => {
  it('maps PIDs to podman container ids and skips host processes', () => {
    const raw = [
      '1234 0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222.scope/container',
      '2345 0::/user.slice/user-1000.slice/user@1000.service/user.slice/libpod-bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cccc3333.scope/container',
      '999 0::/system.slice/sshd.service',
    ].join('\n');
    const map = parseCgroupMap(raw);
    expect(map.size).toBe(2);
    expect(map.get(1234)).toBe('aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222');
    expect(map.get(999)).toBeUndefined();
  });
});

describe('resolveFlows', () => {
  function sockets(): HostSockets {
    return {
      // authelia (container A) listens on 9091; ollama (B) on 11434.
      listening: parseSsRows([
        'LISTEN 0 4096 *:9091 *:* users:(("authelia",pid=10,fd=8))',
        'LISTEN 0 4096 *:11434 *:* users:(("ollama",pid=20,fd=8))',
        'LISTEN 0 4096 *:53 *:* users:(("authelia",pid=10,fd=9))',
      ].join('\n')),
      // media (C) → authelia:9091; hermes (D) → ollama:11434;
      // authelia → its own 9091 (self); something → :53 (DNS).
      established: parseSsRows([
        'ESTAB 0 0 1.2.3.4:5000 1.2.3.4:9091 users:(("media",pid=30,fd=1))',
        'ESTAB 0 0 1.2.3.4:5001 1.2.3.4:11434 users:(("hermes",pid=40,fd=1))',
        'ESTAB 0 0 1.2.3.4:5002 1.2.3.4:9091 users:(("authelia",pid=10,fd=1))',
        'ESTAB 0 0 1.2.3.4:5003 1.2.3.4:53 users:(("media",pid=30,fd=2))',
      ].join('\n')),
      pidToContainer: new Map([[10, 'cA'], [20, 'cB'], [30, 'cC'], [40, 'cD']]),
    };
  }
  const c2s = new Map([['cA', 'auth'], ['cB', 'ollama'], ['cC', 'media'], ['cD', 'hermes']]);

  it('synthesizes directed src→dst edges from listen + estab rows', () => {
    const flows = resolveFlows(sockets(), c2s);
    expect(flows).toContainEqual({ srcService: 'media', dstService: 'auth', dstPort: 9091 });
    expect(flows).toContainEqual({ srcService: 'hermes', dstService: 'ollama', dstPort: 11434 });
  });

  it('drops self-edges and DNS (port 53)', () => {
    const flows = resolveFlows(sockets(), c2s);
    // authelia → authelia:9091 is a self-edge; media → :53 is DNS.
    expect(flows.some(f => f.srcService === f.dstService)).toBe(false);
    expect(flows.some(f => f.dstPort === 53)).toBe(false);
    expect(flows).toHaveLength(2);
  });

  it('drops flows whose peer port is not a known service listener', () => {
    const s = sockets();
    s.established = parseSsRows('ESTAB 0 0 1.2.3.4:5000 1.2.3.4:60000 users:(("media",pid=30,fd=1))');
    expect(resolveFlows(s, c2s)).toEqual([]);
  });
});
