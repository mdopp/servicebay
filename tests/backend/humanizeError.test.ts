import { describe, it, expect } from 'vitest';
import { humanizeError } from '../../src/lib/util/humanizeError';

describe('humanizeError', () => {
    it('returns a fallback for empty input', () => {
        const out = humanizeError(undefined);
        expect(out.title).toMatch(/something went wrong/i);
        expect(out.detail).toContain('unexpected');
    });

    it('detects 401 / unauthorized', () => {
        expect(humanizeError(new Error('Request failed: 401')).title).toMatch(/session expired/i);
        expect(humanizeError('unauthorized').title).toMatch(/session expired/i);
    });

    it('detects 403 / forbidden', () => {
        expect(humanizeError('403 Forbidden').title).toMatch(/permission denied/i);
    });

    it('detects 404 / not found', () => {
        expect(humanizeError('404 Not Found').title).toMatch(/not found/i);
    });

    it('detects agent-disconnect strings', () => {
        const out = humanizeError(new Error('Agent not connected'));
        expect(out.title).toMatch(/agent unreachable/i);
        expect(out.detail).toMatch(/Settings/);
    });

    it('detects ssh key failures', () => {
        const out = humanizeError(new Error('Permission denied (publickey)'));
        expect(out.title).toMatch(/ssh authentication/i);
    });

    it('detects timeouts', () => {
        expect(humanizeError(new Error('ETIMEDOUT')).title).toMatch(/timed out/i);
    });

    it('detects network errors', () => {
        expect(humanizeError(new Error('Failed to fetch')).title).toMatch(/network/i);
    });

    it('returns the raw message when nothing matches', () => {
        const out = humanizeError(new Error('something specific happened'));
        expect(out.detail).toContain('something specific happened');
    });
});
