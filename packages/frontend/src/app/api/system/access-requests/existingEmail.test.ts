import { describe, it, expect, vi } from 'vitest';
import { handleExistingEmail, type ExistingEmailDeps } from './existingEmail';
import type { LldapListUsersResult } from '@/lib/lldap/client';

function deps(over: Partial<ExistingEmailDeps>): ExistingEmailDeps {
  return {
    listUsers: vi.fn(async (): Promise<LldapListUsersResult> => ({ ok: true, users: [] })),
    notifyOwner: vi.fn(async () => {}),
    ...over,
  };
}

describe('handleExistingEmail', () => {
  it('short-circuits + notifies the owner when the email already exists', async () => {
    const notifyOwner = vi.fn(async () => {});
    const d = deps({
      listUsers: vi.fn(async () => ({ ok: true, users: [{ id: 'alice', email: 'Alice@Example.com' }] })),
      notifyOwner,
    });

    // Case-insensitive match on a differently-cased submission.
    const res = await handleExistingEmail(' alice@example.com ', d);

    expect(res.shortCircuit).toBe(true);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    // Notifies the directory address, not the (possibly differently-cased)
    // submitted one.
    expect(notifyOwner.mock.calls[0][0]).toBe('Alice@Example.com');
  });

  it('does not short-circuit and never emails when the email is new', async () => {
    const notifyOwner = vi.fn(async () => {});
    const d = deps({
      listUsers: vi.fn(async () => ({ ok: true, users: [{ id: 'bob', email: 'bob@example.com' }] })),
      notifyOwner,
    });

    const res = await handleExistingEmail('newcomer@example.com', d);

    expect(res.shortCircuit).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('fails open (does not short-circuit) when LLDAP is unreachable', async () => {
    const notifyOwner = vi.fn(async () => {});
    const d = deps({
      listUsers: vi.fn(async () => ({ ok: false, reason: 'network_error', message: 'boom' })),
      notifyOwner,
    });

    const res = await handleExistingEmail('someone@example.com', d);

    expect(res.shortCircuit).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it('still short-circuits when the owner notification throws (never enumerates via error)', async () => {
    const d = deps({
      listUsers: vi.fn(async () => ({ ok: true, users: [{ id: 'carol', email: 'carol@example.com' }] })),
      notifyOwner: vi.fn(async () => { throw new Error('smtp down'); }),
    });

    const res = await handleExistingEmail('carol@example.com', d);

    expect(res.shortCircuit).toBe(true);
  });

  it('ignores directory users with no email', async () => {
    const d = deps({
      listUsers: vi.fn(async () => ({ ok: true, users: [{ id: 'svc' }, { id: 'dave', email: 'dave@example.com' }] })),
    });

    expect((await handleExistingEmail('dave@example.com', d)).shortCircuit).toBe(true);
    expect((await handleExistingEmail('nobody@example.com', d)).shortCircuit).toBe(false);
  });
});
