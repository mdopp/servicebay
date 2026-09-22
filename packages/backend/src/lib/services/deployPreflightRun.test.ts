/**
 * #3020, the half that needs the box: does the image carry the binary?
 *
 * The rules that keep this check from becoming its own failure mode are the
 * ones worth pinning, because each of them is a way a well-meant preflight
 * makes things worse:
 *
 *  - it must never PULL (a deploy is not the moment to drag a layer set over
 *    the network), so an image that is not on the node is "could not check";
 *  - it must never turn our own blindness into a refusal;
 *  - it must never throw, because a preflight that takes the deploy with it is
 *    worse than the fault it looks for.
 */
import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execSafe: vi.fn() }));
// `execSafe` — the one exec path for argv, like every other caller. The first
// cut called `sendCommand('safe_exec', …)` directly to make a test harness
// happy; that wrote no `safe_exec:` audit line, so when the check failed on the
// box there was nothing in the journal to tell "it ran and passed" from "it
// never ran". Changing production to suit a mock is how that happened.
vi.mock('@/lib/executor', () => ({ getExecutor: () => ({ execSafe: mocks.execSafe }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { binaryInImage, preflightDeployment } from './deployPreflightRun';
import { refuses } from './deployPreflight';

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

describe('binaryInImage', () => {
  it('never pulls — a deploy is not the moment to fetch an image', async () => {
    mocks.execSafe.mockResolvedValue({ code: 0, stdout: '/usr/bin/curl', stderr: '' });
    await binaryInImage('Local', 'alpine', 'curl');
    const [argv, opts] = mocks.execSafe.mock.calls[0] as [string[], { check?: boolean }];
    // `check: false` — we READ the exit code; a throwing execSafe would turn
    // "binary absent" into "could not check" and the refusal would never fire.
    expect(opts.check).toBe(false);
    expect(argv).toContain('--pull=never');
    expect(argv).toContain('--rm');
    expect(argv.join(' ')).toContain('command -v curl');
  });

  it('exit 0 WITH the path printed means present', async () => {
    mocks.execSafe.mockResolvedValue({ code: 0, stdout: '/usr/bin/curl', stderr: '' });
    expect(await binaryInImage('Local', 'alpine', 'curl')).toEqual({ present: true });
  });

  it('exit 0 with NO path printed is unknown — something other than our shell ran', async () => {
    // `command -v` prints the path when it finds the binary. A silent 0 means
    // the image's entrypoint swallowed our arguments, or a wrapper lost the
    // real exit code. Reading it as "present" is how a check reports success
    // for something it never established — and it is the leading candidate for
    // why the refusal did not fire on the box (#3020, reopened).
    const r = await (async () => {
      mocks.execSafe.mockResolvedValue({ code: 0, stdout: '   \n', stderr: '' });
      return binaryInImage('Local', 'node:20-alpine', 'curl');
    })();
    expect(r.present).toBeNull();
    expect(r.detail).toContain('printed no path');
  });

  it('overrides the entrypoint, so the image\'s own wrapper cannot reinterpret the arguments', async () => {
    mocks.execSafe.mockClear();
    mocks.execSafe.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    await binaryInImage('Local', 'node:20-alpine', 'curl');
    const argv = mocks.execSafe.mock.calls[0][0] as string[];
    // node:20-alpine's docker-entrypoint.sh rewrites a leading `-c` into
    // `node -c …`, which exits 0 and proves nothing about curl.
    expect(argv).toContain('--entrypoint=sh');
    expect(argv.slice(-2)).toEqual(['-c', 'command -v curl']);
    expect(argv[argv.length - 3]).toBe('node:20-alpine');
  });

  it('exit 1 means genuinely absent — the container ran and answered', async () => {
    mocks.execSafe.mockResolvedValue({ code: 1, stdout: '', stderr: '' });
    expect(await binaryInImage('Local', 'node:20-alpine', 'curl')).toEqual({ present: false });
  });

  it('an image that is not on the node is "could not check", not "absent"', async () => {
    mocks.execSafe.mockResolvedValue({ code: 125, stdout: '', stderr: 'Error: no such image: ghcr.io/x/y:latest' });
    const r = await binaryInImage('Local', 'ghcr.io/x/y:latest', 'curl');
    expect(r.present).toBeNull();
    expect(r.detail).toContain('no such image');
  });

  it('a thrown executor is "could not check", never a refusal', async () => {
    mocks.execSafe.mockRejectedValue(new Error('node unreachable'));
    const r = await binaryInImage('Local', 'alpine', 'curl');
    expect(r.present).toBeNull();
    expect(r.detail).toContain('node unreachable');
  });
});

describe('preflightDeployment', () => {
  it('REFUSES the deployment that reached 1006 restarts', async () => {
    const findings = await preflightDeployment('Local', CURL_IN_ALPINE, undefined, {
      check: async () => ({ present: false }),
    });
    expect(refuses(findings)).toBe(true);
    expect(findings[0].code).toBe('probe-binary-missing');
  });

  it('lets the same manifest through when the image really has curl', async () => {
    const findings = await preflightDeployment('Local', CURL_IN_ALPINE, undefined, {
      check: async () => ({ present: true }),
    });
    expect(findings).toEqual([]);
  });

  it('an unverifiable image WARNS and deploys — blindness is not a refusal', async () => {
    const findings = await preflightDeployment('Local', CURL_IN_ALPINE, undefined, {
      check: async () => ({ present: null, detail: 'no such image' }),
    });
    expect(refuses(findings)).toBe(false);
    expect(findings[0].code).toBe('probe-binary-unverifiable');
  });

  it('reports progress the operator can read, not just a log line', async () => {
    const seen: string[] = [];
    await preflightDeployment('Local', CURL_IN_ALPINE, m => seen.push(m), {
      check: async () => ({ present: false }),
    });
    expect(seen.some(m => m.includes('health probe'))).toBe(true);
    expect(seen.some(m => m.startsWith('✖'))).toBe(true);
  });

  it('a manifest with no exec probe costs nothing and says nothing', async () => {
    const check = vi.fn();
    const y = CURL_IN_ALPINE.replace(/livenessProbe:[\s\S]*$/, '');
    const findings = await preflightDeployment('Local', y, undefined, { check });
    expect(findings).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it('never throws, even on a manifest it cannot parse', async () => {
    await expect(
      preflightDeployment('Local', '{{ not yaml', undefined, { check: async () => ({ present: false }) }),
    ).resolves.toEqual([]);
  });

  it('a check that throws does not take the deploy with it', async () => {
    const findings = await preflightDeployment('Local', CURL_IN_ALPINE, undefined, {
      check: async () => { throw new Error('podman is gone'); },
    });
    expect(refuses(findings)).toBe(false);
  });
});
