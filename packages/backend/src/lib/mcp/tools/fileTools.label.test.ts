/**
 * #2996 — a file this container wrote is not automatically a file another
 * container can read, and the tool used to say otherwise.
 *
 * `write_file` answered `{path, bytes, ownershipSet: true}`. That reads as
 * success, and `ownershipSet: true` actively suggests permissions were handled.
 * They were not: the file carried ServiceBay's own SELinux MCS categories
 * (`…:s0:c1022,c1023`), so a container mounting it via `hostPath` was denied —
 * while `read_file` read it back happily, because we are the one process that
 * can. A session built a deployment on that and watched it 404 for half an
 * hour.
 *
 * What is pinned here is the category parsing (the substring that IS the
 * difference) and the rule that the tool reports the label **on disk**, never
 * the one it asked for — reporting the intended label would be the same false
 * success in a new field.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mcsCategories } from './fileTools';

const SRC = fs.readFileSync(path.join(__dirname, 'fileTools.ts'), 'utf8');
/** #3016 moved the relabel itself into `lib/selinux.ts` so the catalog delivery
 *  could use the same one. These assertions follow the logic rather than the
 *  file they were first written against. */
const SELINUX_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'selinux.ts'), 'utf8');

describe('mcsCategories — the substring that decides whether another container can read it', () => {
  it('finds the categories on the label the box actually produced', () => {
    expect(mcsCategories('unconfined_u:object_r:container_file_t:s0:c1022,c1023')).toBe('c1022,c1023');
  });

  it('finds a single category, and a range', () => {
    expect(mcsCategories('system_u:object_r:container_file_t:s0:c42')).toBe('c42');
    expect(mcsCategories('system_u:object_r:container_file_t:s0:c0.c1023')).toBe('c0.c1023');
  });

  it('reports none for the shared label that is the goal of the fix', () => {
    expect(mcsCategories('unconfined_u:object_r:container_file_t:s0')).toBeNull();
  });

  it('is not fooled by an s-level or by trailing whitespace', () => {
    // `s0-s0:c1,c2` is a RANGE; the categories are still there and still block.
    expect(mcsCategories('system_u:object_r:container_file_t:s0-s0:c1,c2  ')).toBe('c1,c2');
    expect(mcsCategories('system_u:object_r:container_file_t:s0  ')).toBeNull();
  });

  it('reports none for a label with no MCS part at all', () => {
    expect(mcsCategories('unconfined_u:object_r:user_home_t')).toBeNull();
  });
});

describe('the write path reports what is on disk, not what it asked for', () => {
  it('reads the label back with stat rather than assuming chcon worked', () => {
    // The specific failure being guarded: a `chcon` that exits 0 while the
    // label does not change would otherwise be reported as shared.
    expect(SELINUX_SRC).toMatch(/stat', '-c', '%C'/);
    expect(SELINUX_SRC).toContain('chcon reported success but the label did not change');
  });

  it('clears the categories with the same fix the agent-kit checkout needs by hand', () => {
    expect(SELINUX_SRC).toMatch(/'chcon'/);
    expect(SELINUX_SRC).toMatch(/'-l', 's0'/);
  });

  it('warns in terms of the CONSUMER, and names why it is easy to miss', () => {
    expect(SELINUX_SRC).toContain('mounting this path will be');
    expect(SELINUX_SRC).toContain('denied');
    expect(SELINUX_SRC).toContain('easy to miss');
  });

  it('treats a box without SELinux as fine, not as a failure', () => {
    expect(SELINUX_SRC).toContain('no SELinux label');
    expect(SELINUX_SRC).not.toMatch(/labelWarning:.*no SELinux/);
  });

  it('says in the tool description that a labelled file is invisible to the consumer', () => {
    // The description is what an agent reads BEFORE it builds a deployment on
    // this tool. That is the cheapest place to stop the whole failure.
    expect(SRC).toContain('invisible to the service that needs it');
    expect(SRC).toContain('hostPath');
  });
});
