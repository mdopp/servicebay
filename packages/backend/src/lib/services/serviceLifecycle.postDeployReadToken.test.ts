import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #818 — ServiceBay mints the durable, read-scoped Bearer token itself and
 * injects it into the post-deploy env as SB_READ_TOKEN, instead of leaving the
 * external post-deploy.py to mint it (the failure mode: the read token was
 * never minted, so the Solaris pollers fell back to a ~1h rotating admin token
 * that went stale). These lock the injection contract.
 */

vi.mock('@/lib/logger', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/internalToken', () => ({
    getInternalApiToken: () => 'INTERNAL_HMAC',
}));

const createToken = vi.fn();
const listTokens = vi.fn();
const revokeToken = vi.fn();
vi.mock('@/lib/auth/apiTokens', () => ({
    createToken: (...a: unknown[]) => createToken(...a),
    listTokens: (...a: unknown[]) => listTokens(...a),
    revokeToken: (...a: unknown[]) => revokeToken(...a),
}));

// Imported after the mocks are registered.
import { ServiceLifecycle } from './serviceLifecycle';

// buildPostDeployEnvLines is a private static; call it through a typed hole
// (TS `private` isn't runtime-enforced) — same spirit as the sibling tests
// that exercise the delegated module functions directly.
const buildEnvLines = (node: string, svc: string, env: Record<string, string>): Promise<string> =>
    (ServiceLifecycle as unknown as {
        buildPostDeployEnvLines(n: string, s: string, e: Record<string, string>): Promise<string>;
    }).buildPostDeployEnvLines(node, svc, env);

describe('buildPostDeployEnvLines → SB_READ_TOKEN injection (#818)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listTokens.mockResolvedValue([]);
        revokeToken.mockResolvedValue(true);
        createToken.mockResolvedValue({ token: { id: 'aa11bb22', name: 'postdeploy-read:solaris' }, secret: 'sb_read_secret' });
    });

    it('mints a read-only, never-expiring token and injects it as SB_READ_TOKEN', async () => {
        const out = await buildEnvLines('box', 'solaris', { FOO: 'bar' });
        expect(createToken).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'postdeploy-read:solaris', scopes: ['read'], neverExpires: true }),
        );
        expect(out).toContain('SB_READ_TOKEN=sb_read_secret');
        // still carries the existing contract
        expect(out).toContain('SB_API_TOKEN=INTERNAL_HMAC');
        expect(out).toContain('SB_NODE=box');
        expect(out).toContain(`FOO='bar'`);
    });

    it('revokes any prior same-named token first (fresh each deploy, no accumulation)', async () => {
        listTokens.mockResolvedValue([
            { id: 'old11111', name: 'postdeploy-read:solaris' },
            { id: 'keep2222', name: 'postdeploy-read:immich' }, // different service — untouched
        ]);
        await buildEnvLines('box', 'solaris', {});
        expect(revokeToken).toHaveBeenCalledWith('old11111');
        expect(revokeToken).not.toHaveBeenCalledWith('keep2222');
    });

    it('omits SB_READ_TOKEN (but still deploys) when the mint fails', async () => {
        createToken.mockRejectedValue(new Error('token store unavailable'));
        const out = await buildEnvLines('box', 'solaris', { FOO: 'bar' });
        expect(out).not.toContain('SB_READ_TOKEN');
        expect(out).toContain('SB_API_TOKEN=INTERNAL_HMAC');
        expect(out).toContain(`FOO='bar'`);
    });
});
