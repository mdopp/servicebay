/**
 * #3016 — the relabel that makes a delivered path readable by the container it
 * exists for, and the two ways it can lie.
 *
 * `fileTools.label.test.ts` covers the write_file side. This covers the shared
 * module itself, and in particular the property the catalog delivery needs and
 * `write_file` did not: **the root is not proof for a tree.** A recursive
 * relabel that half-worked leaves a shared root over categorised children, and
 * that is precisely the state a reader trips on — an empty directory where 57
 * assists should be.
 */
import { describe, it, expect, vi } from 'vitest';
import { mcsCategories, shareWithOtherContainers, type Run } from './selinux';

/** A fake box: `chcon` succeeds, and `stat` answers per path from a table. */
function boxWith(labels: Record<string, string>, chconCode = 0, chconErr = ''): { run: Run; calls: string[][] } {
  const calls: string[][] = [];
  const run: Run = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'chcon') return { code: chconCode, stdout: '', stderr: chconErr };
    const target = argv[argv.length - 1];
    const label = labels[target];
    return label === undefined
      ? { code: 1, stdout: '', stderr: 'stat: No such file' }
      : { code: 0, stdout: `${label}\n`, stderr: '' };
  };
  return { run, calls };
}

const SHARED = 'unconfined_u:object_r:container_file_t:s0';
const STAMPED = 'unconfined_u:object_r:container_file_t:s0:c1022,c1023';

describe('mcsCategories', () => {
  it.each([
    [STAMPED, 'c1022,c1023'],
    ['system_u:object_r:container_file_t:s0:c42', 'c42'],
    ['system_u:object_r:container_file_t:s0:c0.c1023', 'c0.c1023'],
    ['system_u:object_r:container_file_t:s0-s0:c1,c2  ', 'c1,c2'],
  ])('%s -> %s', (label, expected) => {
    expect(mcsCategories(label)).toBe(expected);
  });

  it.each([SHARED, 'unconfined_u:object_r:user_home_t', ''])('reports none for %s', (label) => {
    expect(mcsCategories(label)).toBeNull();
  });
});

describe('shareWithOtherContainers', () => {
  it('relabels the single path and reports the label it read back', async () => {
    const { run, calls } = boxWith({ '/mnt/data/x': SHARED });
    const r = await shareWithOtherContainers({ run, path: '/mnt/data/x' });
    expect(r.shared).toBe(true);
    expect(r.label).toBe(SHARED);
    expect(r.labelWarning).toBeUndefined();
    expect(calls[0]).toEqual(['chcon', '-l', 's0', '--', '/mnt/data/x']);
  });

  it('passes -R for a tree, so children are relabelled too', async () => {
    const { run, calls } = boxWith({ '/mnt/data/kit': SHARED });
    await shareWithOtherContainers({ run, path: '/mnt/data/kit', recursive: true });
    expect(calls[0]).toEqual(['chcon', '-R', '-l', 's0', '--', '/mnt/data/kit']);
  });

  it('a SHARED ROOT over a STAMPED CHILD is not shared — the #3016 state', async () => {
    // The whole reason `verify` exists. Checking only the root would report
    // success while pi-web sees an empty assists directory.
    const { run } = boxWith({
      '/mnt/data/kit': SHARED,
      '/mnt/data/kit/checkout': SHARED,
      '/mnt/data/kit/checkout/assists': STAMPED,
    });
    const r = await shareWithOtherContainers({
      run,
      path: '/mnt/data/kit',
      recursive: true,
      verify: ['/mnt/data/kit', '/mnt/data/kit/checkout', '/mnt/data/kit/checkout/assists'],
    });
    expect(r.shared).toBe(false);
    expect(r.labelWarning).toContain('/mnt/data/kit/checkout/assists');
    expect(r.labelWarning).toContain('c1022,c1023');
    // And it names which child, not just "something is wrong".
    expect(r.labelWarning).not.toContain('/mnt/data/kit (');
  });

  it('a chcon that exits 0 without changing the label is reported as such', async () => {
    const { run } = boxWith({ '/mnt/data/x': STAMPED }, 0);
    const r = await shareWithOtherContainers({ run, path: '/mnt/data/x' });
    expect(r.shared).toBe(false);
    expect(r.labelWarning).toContain('chcon reported success but the label did not change');
  });

  it('a chcon that failed is reported with what it said', async () => {
    const { run } = boxWith({ '/mnt/data/x': STAMPED }, 1, 'Operation not permitted');
    const r = await shareWithOtherContainers({ run, path: '/mnt/data/x' });
    expect(r.shared).toBe(false);
    expect(r.labelWarning).toContain('Operation not permitted');
  });

  it('names the hand fix an operator would run, including -R for a tree', async () => {
    const { run } = boxWith({ '/mnt/data/kit': STAMPED });
    const r = await shareWithOtherContainers({ run, path: '/mnt/data/kit', recursive: true });
    expect(r.labelWarning).toContain('chcon -R -l s0 /mnt/data/kit');
  });

  it('a box without SELinux is fine, not a failure', async () => {
    const run: Run = async (argv) =>
      argv[0] === 'chcon'
        ? { code: 1, stdout: '', stderr: 'chcon: not supported' }
        : { code: 0, stdout: '?\n', stderr: '' };
    const r = await shareWithOtherContainers({ run, path: '/mnt/data/x' });
    expect(r.shared).toBe(true);
    expect(r.label).toBeNull();
    expect(r.labelNote).toContain('no SELinux label');
    expect(r.labelWarning).toBeUndefined();
  });

  it('a path that cannot be stat-ed at all does not masquerade as shared categories', async () => {
    const { run } = boxWith({});
    const r = await shareWithOtherContainers({ run, path: '/mnt/data/gone' });
    // No label read at all → treated as "no SELinux to speak of", with a note,
    // never as a confident "shared" with a label attached.
    expect(r.label).toBeNull();
    expect(r.labelNote).toBeDefined();
  });

  it('never throws, whatever the box does', async () => {
    const run = vi.fn<Run>(async () => ({ code: 137, stdout: '', stderr: 'killed' }));
    await expect(shareWithOtherContainers({ run, path: '/mnt/data/x' })).resolves.toBeDefined();
  });
});
