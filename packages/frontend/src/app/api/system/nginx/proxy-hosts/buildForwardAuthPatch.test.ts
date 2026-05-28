import { describe, it, expect } from 'vitest';
import { buildForwardAuthPatch } from './route';

// A minimal NPM-style proxy_host conf with a forward-auth `auth_request`
// and a `location /` block that includes proxy.conf (where NPM lays down
// `Host $host`).
const FORWARD_AUTH_CONF = `
server {
  auth_request /authelia;
  location / {
    proxy_set_header X-Forwarded-Method $request_method;
    include conf.d/include/proxy.conf;
  }
}
`;

describe('buildForwardAuthPatch', () => {
    it('skips a conf that is not a forward-auth proxy_host', () => {
        const res = buildForwardAuthPatch('server {\n  location / {\n  }\n}\n', undefined);
        expect(res).toEqual({ skip: 'no forward-auth' });
    });

    it('skips when there is no `location /` block', () => {
        const res = buildForwardAuthPatch('server {\n  auth_request /authelia;\n}\n', undefined);
        expect(res).toEqual({ skip: 'no `location /` block' });
    });

    it('injects Remote-* headers before the proxy.conf include', () => {
        const res = buildForwardAuthPatch(FORWARD_AUTH_CONF, undefined);
        expect('content' in res).toBe(true);
        const content = (res as { content: string }).content;
        expect(content).toContain('proxy_set_header Remote-User $user;');
        // Headers land before the include, not after.
        expect(content.indexOf('Remote-User')).toBeLessThan(content.indexOf('include conf.d/include/proxy.conf;'));
    });

    it('is idempotent — a conf that already has Remote-User is skipped', () => {
        const patched = (buildForwardAuthPatch(FORWARD_AUTH_CONF, undefined) as { content: string }).content;
        expect(buildForwardAuthPatch(patched, undefined)).toEqual({ skip: 'already patched' });
    });

    it('inlines proxy.conf without Host $host and appends the upstream Host override', () => {
        const res = buildForwardAuthPatch(FORWARD_AUTH_CONF, 'hermes.local');
        expect('content' in res).toBe(true);
        const content = (res as { content: string }).content;
        expect(content).toContain('proxy_set_header Host hermes.local;');
        expect(content).toContain('proxy_pass       $forward_scheme://$server:$port$request_uri;');
        // The literal proxy.conf include is replaced by the inline block.
        expect(content).not.toContain('include conf.d/include/proxy.conf;');
    });
});
