/**
 * #3020 — the faults that went through the door, pinned as the exact shapes
 * that shipped.
 *
 * Each case below is a real deployment from 2026-09-19..21, not an invented
 * one. The healthcheck fault happened TWICE, character for character, the
 * second time with a catalog rule already written against it — which is the
 * whole argument for checking here rather than in prose.
 *
 * Two properties matter as much as the detection:
 *
 *  - **A refusal is only for what cannot possibly work.** A probe binary the
 *    image lacks has no working configuration. Everything else warns, because
 *    a refusal on a suspicion blocks someone who means it at the moment they
 *    have no other route (#2995).
 *  - **"could not check" is never "broken".** Blocking a deploy on our own
 *    inability to look would be a worse failure than the one we look for.
 */
import { describe, it, expect } from 'vitest';
import {
  probeBinaries,
  collectProbeCommands,
  inspectManifestShape,
  probeFinding,
  refuses,
  describeFindings,
} from './deployPreflight';

/** The shape that reached 1006 restarts. */
const CURL_IN_ALPINE = `apiVersion: v1
kind: Pod
metadata:
  name: asteroids
spec:
  containers:
    - name: web
      image: docker.io/library/node:20-alpine
      livenessProbe:
        exec:
          command: ["sh", "-c", "curl -f http://localhost:8080/ || exit 1"]
`;

describe('probeBinaries — which binaries a probe really invokes', () => {
  it('sees through a sh -c wrapper, which is how every real probe is written', () => {
    expect(probeBinaries(['sh', '-c', 'curl -f http://localhost:8080/ || exit 1'])).toEqual(['curl']);
  });

  it('finds a bare command too', () => {
    expect(probeBinaries(['curl', '-f', 'http://localhost/'])).toEqual(['curl']);
  });

  it('strips a path, so /usr/bin/curl is still curl', () => {
    expect(probeBinaries(['/usr/bin/curl', '-f', 'http://x/'])).toEqual(['curl']);
  });

  it('finds every command in a chain, not only the first', () => {
    const found = probeBinaries(['sh', '-c', 'nc -z localhost 6379 && redis-cli ping']);
    expect(found).toContain('nc');
    expect(found).toContain('redis-cli');
  });

  it('does NOT report the shell itself — a false refusal there is worse than the fault', () => {
    expect(probeBinaries(['sh', '-c', 'test -f /tmp/ready'])).toEqual([]);
    expect(probeBinaries(['/bin/sh', '-c', 'exit 0'])).toEqual([]);
  });

  it('reports nothing for a command it does not recognise, rather than guessing', () => {
    // An unknown binary might be the app's own CLI, which of course exists in
    // its own image. Guessing here would refuse working deployments.
    expect(probeBinaries(['sh', '-c', '/app/bin/healthcheck --quiet'])).toEqual([]);
    expect(probeBinaries([])).toEqual([]);
  });
});

describe('collectProbeCommands', () => {
  it('finds the probe in the manifest that reached 1006 restarts', () => {
    const found = collectProbeCommands(CURL_IN_ALPINE);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      container: 'web',
      image: 'docker.io/library/node:20-alpine',
      probe: 'livenessProbe',
      binaries: ['curl'],
    });
  });

  it('covers readiness and startup probes, not only liveness', () => {
    const y = CURL_IN_ALPINE
      .replace('livenessProbe', 'readinessProbe')
      + `      startupProbe:
        exec:
          command: ["wget", "-q", "-O-", "http://localhost:8080/"]
`;
    const probes = collectProbeCommands(y).map(p => p.probe);
    expect(probes).toContain('readinessProbe');
    expect(probes).toContain('startupProbe');
  });

  it('ignores a probe with nothing worth checking, and never throws on bad YAML', () => {
    expect(collectProbeCommands(CURL_IN_ALPINE.replace('curl -f http://localhost:8080/ || exit 1', 'test -f /ready'))).toEqual([]);
    expect(collectProbeCommands('{{ not yaml')).toEqual([]);
    expect(collectProbeCommands('')).toEqual([]);
  });

  it('ignores an httpGet probe — podman runs it, not the image', () => {
    const y = `apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: web
      image: docker.io/library/node:20-alpine
      livenessProbe:
        httpGet: { path: /, port: 8080 }
`;
    expect(collectProbeCommands(y)).toEqual([]);
  });
});

describe('probeFinding — refuse only what cannot work', () => {
  const probe = collectProbeCommands(CURL_IN_ALPINE)[0];

  it('a missing binary is a REFUSAL, and says what to do instead', () => {
    const f = probeFinding(probe, 'curl', false)!;
    expect(f.severity).toBe('refuse');
    expect(f.code).toBe('probe-binary-missing');
    expect(f.message).toContain('node:20-alpine');
    expect(f.message).toContain('restart forever');
    expect(f.message).toContain('tcpSocket');
  });

  it('a present binary is no finding at all', () => {
    expect(probeFinding(probe, 'curl', true)).toBeNull();
  });

  it('"could not check" WARNS — never refuses on our own blindness', () => {
    const f = probeFinding(probe, 'curl', null, 'image not pulled')!;
    expect(f.severity).toBe('warn');
    expect(f.code).toBe('probe-binary-unverifiable');
    expect(f.message).toContain('image not pulled');
    expect(refuses([f])).toBe(false);
  });
});

describe('inspectManifestShape — the application smuggled into the spec', () => {
  const withBlob = (field: string) => `apiVersion: v1
kind: Pod
metadata: { name: asteroids }
spec:
  containers:
    - name: web
      image: docker.io/library/node:20-alpine
      ${field}: ["${'QUJDRA'.repeat(200)}"]
`;

  it('warns — never refuses — on a base64 application in args', () => {
    const f = inspectManifestShape(withBlob('args'));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warn');
    expect(f[0].code).toBe('embedded-application');
    expect(refuses(f)).toBe(false);
  });

  it('points at the real question: how does the box get its image', () => {
    const [f] = inspectManifestShape(withBlob('args'));
    expect(f.message).toContain('servicebay images');
    expect(f.message).toContain('release-check');
  });

  it('catches the same shape in command and env', () => {
    expect(inspectManifestShape(withBlob('command'))[0]?.code).toBe('embedded-application');
    expect(inspectManifestShape(withBlob('env'))[0]?.code).toBe('embedded-application');
  });

  it('leaves an ordinary spec alone — a token or a hash is not an application', () => {
    const ordinary = `apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: web
      image: ghcr.io/mdopp/app:latest
      env:
        - { name: SECRET_KEY, value: "aGVsbG8gdGhlcmUgdGhpcyBpcyBub3QgYW4gYXBw" }
        - { name: TZ, value: "Europe/Berlin" }
`;
    expect(inspectManifestShape(ordinary)).toEqual([]);
  });

  it('warns on a spec far past any hand-written size, without double-reporting', () => {
    const big = `apiVersion: v1
kind: Pod
metadata: { name: x }
spec:
  containers:
    - name: web
      image: ghcr.io/mdopp/app:latest
      env:
${Array.from({ length: 900 }, (_, i) => `        - { name: VAR_${i}, value: "${'x'.repeat(30)}" }`).join('\n')}
`;
    const f = inspectManifestShape(big);
    expect(f.map(x => x.code)).toEqual(['oversized-manifest']);
    expect(refuses(f)).toBe(false);
  });

  it('never throws on unparseable YAML', () => {
    expect(inspectManifestShape('{{ nope')).toEqual([]);
  });
});

describe('describeFindings', () => {
  it('puts refusals first — the blocking reason is the one to read', () => {
    const probe = collectProbeCommands(CURL_IN_ALPINE)[0];
    const text = describeFindings([
      ...inspectManifestShape(CURL_IN_ALPINE),
      probeFinding(probe, 'curl', null)!,
      probeFinding(probe, 'curl', false)!,
    ]);
    expect(text.indexOf('[refuse]')).toBeLessThan(text.indexOf('[warn]'));
  });
});
