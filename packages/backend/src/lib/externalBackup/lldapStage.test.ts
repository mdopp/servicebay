import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockNas } = vi.hoisted(() => ({
  mockNas: { nasUpload: vi.fn(), nasDownload: vi.fn(), nasList: vi.fn() },
}));
vi.mock('./nasClient', () => mockNas);

import { stageLldapDirectoryToNas, LLDAP_DIRECTORY_FILE } from './lldapStage';
import { NAS_BACKUP_DIR } from './producer';
import type { LldapDirectory } from '../lldap/client';

beforeEach(() => {
  vi.clearAllMocks();
  mockNas.nasUpload.mockResolvedValue(undefined);
});

describe('stageLldapDirectoryToNas', () => {
  it('writes the directory JSON to sb-backup/ with user/group counts', async () => {
    const dir: LldapDirectory = {
      exportedAt: '2026-05-30T00:00:00Z',
      groups: ['admins', 'family'],
      users: [
        { id: 'alice', email: 'a@x', displayName: 'Alice', groups: ['admins', 'family'] },
        { id: 'bob', groups: [] },
      ],
    };
    const res = await stageLldapDirectoryToNas(dir);

    expect(res).toEqual({ file: LLDAP_DIRECTORY_FILE, users: 2, groups: 2 });
    const [pathArg, buf] = mockNas.nasUpload.mock.calls[0];
    expect(pathArg).toBe(`${NAS_BACKUP_DIR}/${LLDAP_DIRECTORY_FILE}`);
    const parsed = JSON.parse(String(buf));
    expect(parsed.groups).toEqual(['admins', 'family']);
    expect(parsed.users).toHaveLength(2);
    // No password field ever leaves — OPAQUE can't be migrated.
    expect(JSON.stringify(parsed)).not.toContain('password');
  });
});
