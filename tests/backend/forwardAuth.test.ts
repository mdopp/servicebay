import { describe, it, expect } from 'vitest';
import {
  AUTHELIA_FORWARD_AUTH_SENTINEL,
  AUTHELIA_FORWARD_AUTH_SNIPPET,
  DEFAULT_AUTHELIA_PORT,
  expandForwardAuthSentinel,
  sanitizeForwardAuthPort,
  buildAuthSkipLocations,
} from '@/lib/stackInstall/forwardAuth';

/**
 * The expansion helper is what lets four+ services share one nginx
 * forward-auth block instead of duplicating ~600 chars across each
 * `variables.json`. Regressions here would silently leak a literal
 * sentinel string into NPM's config, which the operator only
 * notices on a 502 from the proxied service.
 */
describe('expandForwardAuthSentinel', () => {
  it('expands the bare sentinel to the full nginx snippet', () => {
    expect(expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL)).toBe(AUTHELIA_FORWARD_AUTH_SNIPPET);
  });

  it('appends per-template extras after the sentinel line', () => {
    const input = `${AUTHELIA_FORWARD_AUTH_SENTINEL}\nclient_max_body_size 256M;`;
    const out = expandForwardAuthSentinel(input);
    expect(out?.startsWith(AUTHELIA_FORWARD_AUTH_SNIPPET)).toBe(true);
    expect(out?.endsWith('client_max_body_size 256M;')).toBe(true);
  });

  it('leaves verbatim advanced_config blocks untouched', () => {
    const verbatim = 'auth_request /custom; proxy_set_header X-Custom "1";';
    expect(expandForwardAuthSentinel(verbatim)).toBe(verbatim);
  });

  it('passes undefined / empty through unchanged', () => {
    expect(expandForwardAuthSentinel(undefined)).toBeUndefined();
    expect(expandForwardAuthSentinel('')).toBe('');
  });
});

/**
 * #1677 — the empty-Authelia-port landmine. A forward-auth `proxy_pass`
 * with no port (`http://127.0.0.1:/api/authz/...`) is an nginx `[emerg]`
 * that crashes the WHOLE reverse proxy on the next reload/reboot, taking
 * every domain down. The sanitiser must repair the on-disk conf so one
 * bad host can never emit an empty port.
 */
describe('sanitizeForwardAuthPort (#1677)', () => {
  it('repairs an empty Authelia port to the default 9091', () => {
    const bad = 'location = /authelia {\n  proxy_pass http://127.0.0.1:/api/authz/auth-request;\n}\n';
    const out = sanitizeForwardAuthPort(bad);
    expect(out.repaired).toBe(true);
    expect(out.content).toContain(`proxy_pass http://127.0.0.1:${DEFAULT_AUTHELIA_PORT}/api/authz/auth-request;`);
    // Never leaves an empty port behind.
    expect(out.content).not.toContain('127.0.0.1:/api/authz');
  });

  it('is a no-op (not repaired) when the port is already concrete', () => {
    const good = 'proxy_pass http://127.0.0.1:9091/api/authz/auth-request;\n';
    const out = sanitizeForwardAuthPort(good);
    expect(out.repaired).toBe(false);
    expect(out.content).toBe(good);
  });

  it('honours a custom port override', () => {
    const bad = 'proxy_pass http://127.0.0.1:/api/authz/auth-request;';
    const out = sanitizeForwardAuthPort(bad, '9999');
    expect(out.content).toContain('http://127.0.0.1:9999/api/authz/auth-request');
  });
});

/**
 * The rendered snippet must NEVER ship a literal empty port, and must
 * carry the #1680 ACME-challenge auth-bypass so LE HTTP-01 isn't
 * swallowed by the server-level `auth_request`.
 */
describe('AUTHELIA_FORWARD_AUTH_SNIPPET', () => {
  it('references the AUTHELIA_PORT placeholder (never a bare empty port)', () => {
    expect(AUTHELIA_FORWARD_AUTH_SNIPPET).toContain('http://127.0.0.1:{{AUTHELIA_PORT}}/api/authz/auth-request');
    expect(AUTHELIA_FORWARD_AUTH_SNIPPET).not.toContain('127.0.0.1:/api/authz');
  });

  it('exposes the LE acme-challenge path with forward-auth disabled (#1680)', () => {
    expect(AUTHELIA_FORWARD_AUTH_SNIPPET).toContain('location /.well-known/acme-challenge/');
    expect(AUTHELIA_FORWARD_AUTH_SNIPPET).toContain('auth_request off;');
  });
});

/**
 * #2210 — per-path forward-auth exceptions. A gated host can let specific
 * public path prefixes (TWA assetlinks, ACME, PWA static assets) skip
 * Authelia while everything else stays behind auth_request.
 */
describe('authSkipPaths (#2210)', () => {
  it('builds an auth_request off location that still proxies upstream', () => {
    const out = buildAuthSkipLocations(['/.well-known/assetlinks.json']);
    expect(out).toContain('location ^~ /.well-known/assetlinks.json {');
    expect(out).toContain('auth_request off;');
    // reuses NPM's own server-level upstream vars — no concrete host needed
    expect(out).toContain('proxy_pass $forward_scheme://$server:$port;');
  });

  it('emits one block per path, prefix-matched (^~), deduped', () => {
    const out = buildAuthSkipLocations(['/.well-known/', '/static/', '/.well-known/']);
    expect(out.match(/location \^~ /g)?.length).toBe(2);
    expect(out).toContain('location ^~ /.well-known/ {');
    expect(out).toContain('location ^~ /static/ {');
  });

  it('refuses acme-challenge (NPM owns that location) and non-absolute paths', () => {
    const out = buildAuthSkipLocations(['/.well-known/acme-challenge/', 'relative/path', '/ok/']);
    expect(out).not.toContain('acme-challenge');
    expect(out).not.toContain('relative/path');
    expect(out).toContain('location ^~ /ok/ {');
  });

  it('returns empty for no paths', () => {
    expect(buildAuthSkipLocations(undefined)).toBe('');
    expect(buildAuthSkipLocations([])).toBe('');
  });

  it('appends skip locations onto the expanded forward-auth snippet', () => {
    const out = expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL, {
      authSkipPaths: ['/.well-known/'],
    });
    // core forward-auth still present + the bypass appended
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('location ^~ /.well-known/ {');
    expect(out).toContain('auth_request off;');
  });

  it('does not collide with NPM acme on LE hosts: omitAcmeBypass + /.well-known/ skip yields distinct locations', () => {
    const out = expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL, {
      omitAcmeBypass: true,
      authSkipPaths: ['/.well-known/'],
    })!;
    // our own acme-challenge bypass is omitted (NPM provides it)...
    expect(out).not.toContain('location /.well-known/acme-challenge/ {');
    // ...and our /.well-known/ skip is a DIFFERENT (shorter ^~ prefix) location
    expect(out).toContain('location ^~ /.well-known/ {');
  });
});
