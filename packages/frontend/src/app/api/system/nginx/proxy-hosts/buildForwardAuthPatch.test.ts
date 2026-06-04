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

    // #1683 — ollama's anti-DNS-rebind guard only accepts a LOCAL Host.
    // The patch must send exactly ONE Host (the local one), REPLACING
    // proxy.conf's `Host $host` — not appending a second Host line
    // (which makes nginx forward two Hosts and ollama 400s).
    it('sends a SINGLE local Host to the upstream — no duplicate Host header (#1683)', () => {
        const res = buildForwardAuthPatch(FORWARD_AUTH_CONF, '127.0.0.1:11434');
        expect('content' in res).toBe(true);
        const content = (res as { content: string }).content;
        // Exactly one Host header, and it's the local one.
        const hostLines = content.match(/proxy_set_header\s+Host\s+\S+;/g) ?? [];
        expect(hostLines).toEqual(['proxy_set_header Host 127.0.0.1:11434;']);
        // proxy.conf (which would re-add `Host $host`) is inlined out.
        expect(content).not.toContain('include conf.d/include/proxy.conf;');
        expect(content).not.toContain('Host $host');
    });

    // #1677 — an empty Authelia port (`127.0.0.1:/api/authz/...`) regenerated
    // by NPM must be repaired even on a conf that is otherwise already
    // patched, because the empty port is an nginx [emerg] that crashes the
    // whole proxy on reload.
    it('repairs an empty Authelia port even when headers are already present (#1677)', () => {
        const ALREADY_PATCHED_BAD_PORT = `
server {
  auth_request /authelia;
  location = /authelia {
    proxy_pass http://127.0.0.1:/api/authz/auth-request;
  }
  location / {
    proxy_set_header Remote-User $user;
    include conf.d/include/proxy.conf;
  }
}
`;
        const res = buildForwardAuthPatch(ALREADY_PATCHED_BAD_PORT, undefined);
        expect('content' in res).toBe(true);
        const content = (res as { content: string }).content;
        expect(content).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
        expect(content).not.toContain('127.0.0.1:/api/authz');
    });

    it('still skips an already-patched conf whose port is concrete (#1677)', () => {
        const ALREADY_PATCHED_GOOD = `
server {
  auth_request /authelia;
  location = /authelia {
    proxy_pass http://127.0.0.1:9091/api/authz/auth-request;
  }
  location / {
    proxy_set_header Remote-User $user;
    include conf.d/include/proxy.conf;
  }
}
`;
        expect(buildForwardAuthPatch(ALREADY_PATCHED_GOOD, undefined)).toEqual({ skip: 'already patched' });
    });
});
