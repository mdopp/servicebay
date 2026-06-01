import { describe, it, expect } from 'vitest';
import { isPortalBlockedForRequest } from './lanGate';

// Production reality: behind NPM the RSC peer is loopback, so the
// resolver trusts X-Real-IP. These cases pin both the "off" no-op and
// the LAN/public classification through the proxy headers.
const loopbackPeer = '127.0.0.1';

describe('isPortalBlockedForRequest (#1456)', () => {
  it('never blocks when lanOnly is off (undefined/false)', () => {
    expect(isPortalBlockedForRequest(undefined, { 'x-real-ip': '8.8.8.8' }, loopbackPeer)).toBe(false);
    expect(isPortalBlockedForRequest(false, { 'x-real-ip': '8.8.8.8' }, loopbackPeer)).toBe(false);
  });

  it('blocks a public client when lanOnly is on', () => {
    expect(isPortalBlockedForRequest(true, { 'x-real-ip': '8.8.8.8' }, loopbackPeer)).toBe(true);
  });

  it('allows a LAN client (RFC1918 X-Real-IP via the proxy)', () => {
    expect(isPortalBlockedForRequest(true, { 'x-real-ip': '192.168.178.50' }, loopbackPeer)).toBe(false);
    expect(isPortalBlockedForRequest(true, { 'x-real-ip': '10.0.0.4' }, loopbackPeer)).toBe(false);
  });

  it('uses the last X-Forwarded-For hop when X-Real-IP is absent', () => {
    // last hop is nginx-appended (trusted); a spoofed left-most LAN IP must not win.
    expect(isPortalBlockedForRequest(true, { 'x-forwarded-for': '192.168.1.9, 8.8.8.8' }, loopbackPeer)).toBe(true);
    expect(isPortalBlockedForRequest(true, { 'x-forwarded-for': '8.8.8.8, 192.168.1.9' }, loopbackPeer)).toBe(false);
  });

  it('falls back to the socket peer for a direct (non-loopback) connection, ignoring spoofable headers', () => {
    expect(isPortalBlockedForRequest(true, { 'x-real-ip': '192.168.1.9' }, '8.8.8.8')).toBe(true);
    expect(isPortalBlockedForRequest(true, {}, '192.168.1.9')).toBe(false);
  });
});
