import { describe, it, expect } from 'vitest';
import { classifyForwardAuthDrift } from './forwardAuthDrift';
import {
  AUTHELIA_FORWARD_AUTH_SENTINEL,
  buildAutheliaSessionMintLocation,
  renderForwardAuthAdvancedConfig,
} from '@/lib/stackInstall/forwardAuth';

/**
 * #2932 criterion 2 — a host that lost its `auth_request` must be REPORTED
 * by diagnose, not pass as green.
 *
 * The failure this pins is a reporting failure: every other signal is happy
 * for exactly this fault. NPM accepted the conf (`nginx_online: true`), the
 * upstream is alive so `dangling_proxy` is quiet, and `get_proxy_routes`
 * plus the UI still describe the host as SSO-gated. Only the config text
 * itself contradicts them.
 */

const GATED = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, '9091', {
  omitAcmeBypass: true,
  authSkipPaths: ['/.well-known/', '/static/'],
})!;

/** The same host after the server-level gate is dropped — the Remote-*
 *  wiring and the internal auth-request upstream stay behind. */
const LOST_AUTH_REQUEST = GATED.replace('auth_request /authelia;\n', '');

/** The #2932 exploit shape: still gated on paper, bypassed everywhere. */
const HOST_WIDE_BYPASS = `${GATED}\n\nlocation ^~ / {\n    auth_request off;\n    include conf.d/include/proxy.conf;\n}`;

describe('classifyForwardAuthDrift (#2932)', () => {
  it('reports a host whose live config lost its auth_request', () => {
    const drift = classifyForwardAuthDrift([
      { domain: 'files.example.test', advancedConfig: LOST_AUTH_REQUEST },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('auth-request-missing');
    expect(drift[0].domain).toBe('files.example.test');
    // The detail must say what it MEANS, not just name a directive.
    expect(drift[0].detail).toMatch(/unauthenticated/);
  });

  it('reports a gated host whose skip list covers every path', () => {
    const drift = classifyForwardAuthDrift([
      { domain: 'sync.example.test', advancedConfig: HOST_WIDE_BYPASS },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0].kind).toBe('host-wide-bypass');
    expect(drift[0].detail).toContain('"/"');
  });

  it('reports a config whose blocks do not close', () => {
    const drift = classifyForwardAuthDrift([
      { domain: 'broken.example.test', advancedConfig: `${GATED}\nlocation ^~ /x {\n    auth_request off;\n` },
    ]);
    expect(drift.map(d => d.kind)).toEqual(['unparseable']);
  });

  it('passes a healthy gated host — including one with real skip prefixes', () => {
    expect(classifyForwardAuthDrift([
      { domain: 'home.example.test', advancedConfig: GATED },
    ])).toEqual([]);
  });

  it('ignores a host that never claimed forward-auth', () => {
    expect(classifyForwardAuthDrift([
      { domain: 'public.example.test', advancedConfig: 'client_max_body_size 0;' },
      { domain: 'empty.example.test', advancedConfig: '' },
    ])).toEqual([]);
  });

  it('rates each host independently in a mixed fleet', () => {
    const drift = classifyForwardAuthDrift([
      { domain: 'ok.example.test', advancedConfig: GATED },
      { domain: 'lost.example.test', advancedConfig: LOST_AUTH_REQUEST },
      { domain: 'open.example.test', advancedConfig: HOST_WIDE_BYPASS },
      { domain: 'plain.example.test', advancedConfig: 'add_header X 1;' },
    ]);
    expect(drift.map(d => `${d.domain}:${d.kind}`)).toEqual([
      'lost.example.test:auth-request-missing',
      'open.example.test:host-wide-bypass',
    ]);
  });

  // Found on the live box while building #2932: the portal apex and `www.`
  // carry the #2278/#2281 session-mint block, which forward-auths exactly
  // three paths from INSIDE a regex location and deliberately has no
  // server-level `auth_request`. An earlier cut of the classifier read that
  // as "a gated host that lost its gate" and flagged both — a probe that
  // cries wolf is as useless as one that stays green.
  it('ignores a host that forward-auths only a few paths from inside a location', () => {
    const mintHost = buildAutheliaSessionMintLocation('synthetic-internal-token', 'www.example.test', '9091');
    expect(mintHost).toContain('auth_request /authelia;');
    expect(classifyForwardAuthDrift([
      { domain: 'example.test', advancedConfig: mintHost },
      { domain: 'www.example.test', advancedConfig: mintHost },
    ])).toEqual([]);
  });

  it('does not mistake the acme bypass or the LAN/error pages for a host-wide hole', () => {
    // A LAN host keeps our own acme-challenge location; the denied-page
    // wiring adds `location = /…` internal blocks. Neither covers "/".
    const lanHost = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, '9091', {
      authSkipPaths: ['/static/'],
    })!;
    const withPages = `${lanHost}\n\nlocation = /servicebay-lan-denied {\n    internal;\n    root /data/nginx/pages;\n}`;
    expect(classifyForwardAuthDrift([{ domain: 'lan.example.test', advancedConfig: withPages }])).toEqual([]);
  });
});
