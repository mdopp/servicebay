import { describe, it, expect } from 'vitest';
import {
  AUTHELIA_FORWARD_AUTH_SENTINEL,
  expandForwardAuthSentinel,
  renderForwardAuthAdvancedConfig,
  DEFAULT_AUTHELIA_PORT,
} from './forwardAuth';

describe('expandForwardAuthSentinel', () => {
  it('expands the bare sentinel into the auth_request snippet (still {{AUTHELIA_PORT}}-templated)', () => {
    const out = expandForwardAuthSentinel(AUTHELIA_FORWARD_AUTH_SENTINEL)!;
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('{{AUTHELIA_PORT}}'); // installer Mustache-renders this later
    expect(out).not.toContain(AUTHELIA_FORWARD_AUTH_SENTINEL);
  });
  it('expands the prefix form and keeps the appended extras', () => {
    const out = expandForwardAuthSentinel(`${AUTHELIA_FORWARD_AUTH_SENTINEL}\nclient_max_body_size 0;`)!;
    expect(out).toContain('auth_request /authelia;');
    expect(out).toContain('client_max_body_size 0;');
  });
  it('leaves a non-sentinel config untouched, and undefined as undefined', () => {
    expect(expandForwardAuthSentinel('proxy_set_header X 1;')).toBe('proxy_set_header X 1;');
    expect(expandForwardAuthSentinel(undefined)).toBeUndefined();
  });
});

describe('renderForwardAuthAdvancedConfig — the no-Mustache (direct API) path', () => {
  it('expands the sentinel AND substitutes the port — no sentinel or placeholder survives', () => {
    const out = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, '9091')!;
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    expect(out).not.toContain('{{AUTHELIA_PORT}}'); // would be an invalid nginx directive
    expect(out).not.toContain(AUTHELIA_FORWARD_AUTH_SENTINEL); // the #files-down bug
  });
  it('defaults the port to DEFAULT_AUTHELIA_PORT when none is given', () => {
    const out = renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL)!;
    expect(out).toContain(`http://127.0.0.1:${DEFAULT_AUTHELIA_PORT}/api/authz/auth-request;`);
  });
  it('renders the prefix-form extras with the port substituted too', () => {
    const out = renderForwardAuthAdvancedConfig(`${AUTHELIA_FORWARD_AUTH_SENTINEL}\nproxy_read_timeout 1h;`, '9091')!;
    expect(out).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    expect(out).toContain('proxy_read_timeout 1h;');
  });
  it('passes a non-forward-auth config through unchanged', () => {
    expect(renderForwardAuthAdvancedConfig('add_header X 1;', '9091')).toBe('add_header X 1;');
    expect(renderForwardAuthAdvancedConfig(undefined, '9091')).toBeUndefined();
  });
});
