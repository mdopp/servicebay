import { describe, it, expect } from 'vitest';
import { parseListenSnapshot, hasListener, LISTEN_SNAPSHOT_COMMAND } from './listenSnapshot';

// The `Local Address:Port` column of `ss -ltn`, deduplicated — exactly
// what LISTEN_SNAPSHOT_COMMAND emits on the box.
const SNAPSHOT = [
  '0.0.0.0:22',
  '127.0.0.1:3000',
  '127.0.0.53:53',
  '[::]:8096',
  '[::1]:9091',
  '192.168.178.100:8701',
  '*:5888',
].join('\n');

describe('parseListenSnapshot', () => {
  it('reads every bind form ss emits — v4, wildcard, bracketed v6, star', () => {
    const snap = parseListenSnapshot(SNAPSHOT);
    expect(snap.empty).toBe(false);
    expect(snap.ports).toEqual([22, 53, 3000, 5888, 8096, 8701, 9091]);
    expect(snap.binds.get(8096)).toEqual(['::']);
    expect(snap.binds.get(5888)).toEqual(['*']);
    expect(snap.binds.get(8701)).toEqual(['192.168.178.100']);
  });

  it('collapses several binds of one port into that port', () => {
    const snap = parseListenSnapshot('127.0.0.1:8080\n192.168.178.100:8080\n127.0.0.1:8080\n');
    expect(snap.ports).toEqual([8080]);
    expect(snap.binds.get(8080)).toEqual(['127.0.0.1', '192.168.178.100']);
  });

  it('drops an IPv6 zone id — it says nothing about reachability', () => {
    expect(parseListenSnapshot('[fe80::1%eth0]:546').binds.get(546)).toEqual(['fe80::1']);
  });

  it('skips junk lines rather than inventing a port', () => {
    const snap = parseListenSnapshot('Local Address:Port\n\nnot-an-address\n0.0.0.0:notaport\n127.0.0.1:80');
    expect(snap.ports).toEqual([80]);
  });

  it('reports an unreadable snapshot as empty, not as "everything closed"', () => {
    expect(parseListenSnapshot('').empty).toBe(true);
    expect(parseListenSnapshot(undefined).empty).toBe(true);
  });
});

describe('hasListener', () => {
  const snap = parseListenSnapshot(SNAPSHOT);

  it('answers "unknown", never "closed", when the snapshot could not be taken', () => {
    expect(hasListener(parseListenSnapshot(''), '127.0.0.1', 11434)).toBeUndefined();
  });

  it('calls a port nobody has open closed — the ollama.dopp.cloud case (#2860)', () => {
    expect(hasListener(snap, '127.0.0.1', 11434)).toBe(false);
  });

  it('treats a wildcard bind as serving every forward host', () => {
    expect(hasListener(snap, '127.0.0.1', 22)).toBe(true);
    expect(hasListener(snap, '192.168.178.100', 22)).toBe(true);
    expect(hasListener(snap, '127.0.0.1', 8096)).toBe(true);
    expect(hasListener(snap, '127.0.0.1', 5888)).toBe(true);
  });

  it('serves a loopback forward host from any loopback bind, ::1 and 127.0.0.0/8 included', () => {
    expect(hasListener(snap, '127.0.0.1', 3000)).toBe(true);
    expect(hasListener(snap, 'localhost', 9091)).toBe(true);
    expect(hasListener(snap, '127.0.0.1', 53)).toBe(true);
  });

  it('does not let a LAN-only bind serve a loopback route, or the reverse', () => {
    expect(hasListener(snap, '127.0.0.1', 8701)).toBe(false);
    expect(hasListener(snap, '192.168.178.100', 8701)).toBe(true);
    expect(hasListener(snap, '192.168.178.100', 3000)).toBe(false);
  });

  it('falls back to the port alone when the route records no forward host', () => {
    expect(hasListener(snap, undefined, 3000)).toBe(true);
    expect(hasListener(snap, '', 11434)).toBe(false);
  });
});

describe('LISTEN_SNAPSHOT_COMMAND', () => {
  it('keeps the bind address — the port alone cannot answer a loopback route', () => {
    // The pre-#2860 command awk-ed the address off on the box
    // (`awk -F: '{print $NF}'`), which is why the check could not exist.
    expect(LISTEN_SNAPSHOT_COMMAND).toContain('ss -ltn');
    expect(LISTEN_SNAPSHOT_COMMAND).not.toContain('$NF');
  });
});
