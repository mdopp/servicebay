import { describe, it, expect } from 'vitest';
import { decideNginxOnline } from './route';

// #2156 — after NPM returns HTTP 200 for a created host, the caller reads
// the live meta.nginx_online and flags the step when nginx refused the conf.
// This exercises that decision (the flag-the-step path) without standing up
// the whole POST handler.
describe('decideNginxOnline', () => {
    it('treats nginx_online=false as a failure and surfaces nginx_err', () => {
        const r = decideNginxOnline({
            nginx_online: false,
            nginx_err: 'nginx: [emerg] duplicate location "/.well-known/acme-challenge/"',
        });
        expect(r.online).toBe(false);
        expect(r.err).toMatch(/duplicate location/);
    });

    it('supplies a fallback message when nginx_online=false but nginx_err is empty', () => {
        const r = decideNginxOnline({ nginx_online: false, nginx_err: null });
        expect(r.online).toBe(false);
        expect(r.err).toMatch(/reverted the conf/);
    });

    it('is fail-open: nginx_online=true is online', () => {
        expect(decideNginxOnline({ nginx_online: true }).online).toBe(true);
    });

    it('is fail-open: undefined meta / undefined status is online', () => {
        expect(decideNginxOnline(undefined).online).toBe(true);
        expect(decideNginxOnline({}).online).toBe(true);
    });
});
