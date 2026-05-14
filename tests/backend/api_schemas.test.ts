import { describe, it, expect } from 'vitest';
import {
  ContainerId,
  ServiceName,
  NodeName,
  HostString,
  HealthCheckTarget,
  BackupFileName,
  CheckIdString,
} from '../../src/lib/api/schemas';

describe('ContainerId', () => {
  it('accepts well-formed names', () => {
    expect(ContainerId.safeParse('nginx').success).toBe(true);
    expect(ContainerId.safeParse('a1.b2_c-3').success).toBe(true);
    expect(ContainerId.safeParse('1234567890abcdef').success).toBe(true);
  });
  it('rejects shell metacharacters', () => {
    for (const bad of ['nginx;rm', '`whoami`', '$(echo)', 'a b', 'a/b', 'a"b', "a'b"]) {
      expect(ContainerId.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('ServiceName', () => {
  it('accepts unit names', () => {
    expect(ServiceName.safeParse('podman.service').success).toBe(true);
    expect(ServiceName.safeParse('user@1000.service').success).toBe(true);
  });
  it('rejects slashes and metacharacters', () => {
    expect(ServiceName.safeParse('foo;bar').success).toBe(false);
    expect(ServiceName.safeParse('foo bar').success).toBe(false);
  });
});

describe('NodeName', () => {
  it('alnum and dashes only', () => {
    expect(NodeName.safeParse('Local').success).toBe(true);
    expect(NodeName.safeParse('node-01').success).toBe(true);
    expect(NodeName.safeParse('node 01').success).toBe(false);
    expect(NodeName.safeParse('').success).toBe(false);
  });
});

describe('HostString', () => {
  it('accepts hostnames and IPs', () => {
    expect(HostString.safeParse('1.1.1.1').success).toBe(true);
    expect(HostString.safeParse('example.com').success).toBe(true);
    expect(HostString.safeParse('[::1]').success).toBe(true);
  });
  it('rejects shell metacharacters', () => {
    for (const bad of ['1.1.1.1; rm /tmp', '$(whoami)', '`id`', 'host with space']) {
      expect(HostString.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('HealthCheckTarget', () => {
  it('accepts URLs and plain strings', () => {
    expect(HealthCheckTarget.safeParse('https://example.com/health').success).toBe(true);
    expect(HealthCheckTarget.safeParse('podman-name').success).toBe(true);
  });
  it('rejects shell metacharacters', () => {
    for (const bad of ['x; ls', 'a $(b)', '`cat /etc/passwd`', 'a|b', 'a&b', 'a\nb']) {
      expect(HealthCheckTarget.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('BackupFileName', () => {
  it('accepts plain filenames', () => {
    expect(BackupFileName.safeParse('backup-2026-05-03.tar.gz').success).toBe(true);
  });
  it('rejects path traversal and separators', () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '..', '.hidden']) {
      expect(BackupFileName.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('CheckIdString', () => {
  it('accepts UUID-shaped IDs from HealthStore.saveCheck', () => {
    expect(CheckIdString.safeParse('11111111-2222-3333-4444-555555555555').success).toBe(true);
  });
  it('accepts deterministic auto-managed IDs', () => {
    for (const good of [
      'domain:files.dopp.cloud',
      'letsdebug:vault.dopp.cloud',
      'lan_ip_drift',
      'npm_auth',
      'cert_expiry',
      'cert_request_failure',
    ]) {
      expect(CheckIdString.safeParse(good).success, good).toBe(true);
    }
  });
  it('rejects path traversal and shell metacharacters', () => {
    for (const bad of [
      '../etc/passwd',
      'a/b',
      'a\\b',
      'foo;rm',
      '`whoami`',
      '$(echo)',
      'with space',
      '',
      'x'.repeat(129),
    ]) {
      expect(CheckIdString.safeParse(bad).success, bad).toBe(false);
    }
  });
});
