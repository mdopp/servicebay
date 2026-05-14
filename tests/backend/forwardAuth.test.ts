import { describe, it, expect } from 'vitest';
import {
  AUTHELIA_FORWARD_AUTH_SENTINEL,
  AUTHELIA_FORWARD_AUTH_SNIPPET,
  expandForwardAuthSentinel,
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
