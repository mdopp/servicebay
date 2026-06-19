import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point DATA_DIR at a throwaway temp dir so the store writes real files we can read
// back — profiles.ts joins DATA_DIR/disk-import-profiles at module load.
let TMP = '';
vi.mock('@/lib/dirs', () => ({ get DATA_DIR() { return TMP; } }));

const { profilesDir, saveProfile, listProfiles, deleteProfile } = await import('./profiles');

beforeEach(async () => {
  TMP = await mkdtemp(path.join(tmpdir(), 'di-profiles-'));
});
afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('disk-import routing presets (#2007)', () => {
  const rules = { '': { owner: 'shared' }, photos: { owner: 'mdopp', disposition: 'photos_immich' } } as never;

  it('saves a preset and lists it back (round-trip)', async () => {
    const saved = await saveProfile({ name: 'Family backup', rules });
    expect(saved).toMatchObject({ name: 'Family backup', rules });
    expect(saved.savedAt).toBeGreaterThan(0);

    const list = await listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Family backup', rules });
  });

  it('re-saving the same name OVERWRITES (slug is the on-disk key), not duplicates', async () => {
    await saveProfile({ name: 'Trip 2021', rules: {} as never });
    await saveProfile({ name: 'trip 2021', rules: { docs: { owner: 'mdopp' } } as never });
    const list = await listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0].rules).toMatchObject({ docs: { owner: 'mdopp' } });
  });

  it('lists newest first and deletes by name', async () => {
    await saveProfile({ name: 'first', rules: {} as never });
    await new Promise(r => setTimeout(r, 2));
    await saveProfile({ name: 'second', rules: {} as never });
    expect((await listProfiles()).map(p => p.name)).toEqual(['second', 'first']);

    await deleteProfile('first');
    expect((await listProfiles()).map(p => p.name)).toEqual(['second']);
    // Deleting a missing preset is a no-op.
    await expect(deleteProfile('gone')).resolves.toBeUndefined();
  });

  it('neutralizes path-traversal in a name to a safe stem inside the dir', async () => {
    // The slug strips separators/dots, so this can't escape — it saves as a tame
    // `etc-passwd.json` UNDER the profiles dir, never `../../etc/passwd`.
    await saveProfile({ name: '../../etc/passwd', rules: {} as never });
    const files = await readdir(profilesDir());
    expect(files).toEqual(['etc-passwd.json']);
    files.forEach(f => expect(f.includes('/')).toBe(false));
  });

  it('rejects a blank name and one that slugs to nothing', async () => {
    await expect(saveProfile({ name: '   ', rules: {} as never })).rejects.toThrow(/preset name required/);
    await expect(saveProfile({ name: '...', rules: {} as never })).rejects.toThrow(/invalid preset name/);
    const files = await readdir(profilesDir()).catch(() => []);
    expect(files).toEqual([]);
  });

  it('skips a corrupt preset file rather than failing the whole list', async () => {
    await saveProfile({ name: 'good', rules: {} as never });
    await writeFile(path.join(profilesDir(), 'broken.json'), '{ not json', 'utf-8');
    const list = await listProfiles();
    expect(list.map(p => p.name)).toEqual(['good']);
  });
});
