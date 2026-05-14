import { describe, it, expect } from 'vitest';
import {
  buildPortSourceMap,
  renderUnexpectedPort,
  BUILTIN_PORT_SOURCES,
} from './portsProbe';

describe('buildPortSourceMap', () => {
  it('starts with the built-in system ports (sshd, servicebay)', () => {
    const m = buildPortSourceMap(undefined, undefined);
    for (const [port, label] of BUILTIN_PORT_SOURCES) {
      expect(m.get(port)).toBe(label);
    }
  });

  it('walks twin.services.ports and tags each with the service name', () => {
    const m = buildPortSourceMap(
      [{ name: 'nginx', ports: [{ hostPort: 80 }, { hostPort: 443 }] }],
      undefined,
    );
    expect(m.get(80)).toBe('nginx');
    expect(m.get(443)).toBe('nginx');
  });

  it('walks twin.containers.ports — sibling pod containers (Immich Postgres/Redis)', () => {
    // Regression for #497: 5432/6379 used to flag as unexpected because
    // the probe ignored container-level port mappings.
    const m = buildPortSourceMap(
      [{ name: 'immich', ports: [{ hostPort: 2283 }] }],
      [
        { id: 'pg-id-12345', names: ['/immich-postgres'], ports: [{ hostPort: 5432 }] },
        { id: 'rd-id-67890', names: ['/immich-redis'], ports: [{ hostPort: 6379 }] },
      ],
    );
    expect(m.get(2283)).toBe('immich');
    expect(m.get(5432)).toBe('immich-postgres');
    expect(m.get(6379)).toBe('immich-redis');
  });

  it('falls back to a container-id label when the container has no name', () => {
    const m = buildPortSourceMap(undefined, [
      { id: 'abcdef0123456789', ports: [{ hostPort: 9000 }] },
    ]);
    expect(m.get(9000)).toBe('container abcdef012345');
  });

  it('lets services win port ownership over containers (first-write-wins)', () => {
    // A service with a published port should be more meaningful to
    // surface than the underlying container's own mapping.
    const m = buildPortSourceMap(
      [{ name: 'adguard', ports: [{ hostPort: 53 }] }],
      [{ id: 'x', names: ['/adguard-ctr'], ports: [{ hostPort: 53 }] }],
    );
    expect(m.get(53)).toBe('adguard');
  });

  it('skips port entries with no hostPort', () => {
    const m = buildPortSourceMap(
      [{ name: 'svc', ports: [{ hostPort: undefined }] }],
      [{ id: 'x', names: ['/c'], ports: [{}] }],
    );
    expect([...m.keys()].sort()).toEqual([22, 5888]);
  });
});

describe('renderUnexpectedPort', () => {
  const sources = new Map([[5432, 'immich-postgres'], [6379, 'immich-redis']]);

  it('appends the owning container/service name when known', () => {
    expect(renderUnexpectedPort('5432', sources)).toBe('5432 (immich-postgres)');
    expect(renderUnexpectedPort('6379', sources)).toBe('6379 (immich-redis)');
  });

  it('falls back to (unknown) when the twin has no source', () => {
    // Operator started something on the host outside any container — the
    // probe still reports it but flags it as outside ServiceBay's view.
    expect(renderUnexpectedPort('9100', sources)).toBe('9100 (unknown)');
  });

  it('handles non-numeric port strings gracefully', () => {
    expect(renderUnexpectedPort('not-a-port', sources)).toBe('not-a-port (unknown)');
  });
});
