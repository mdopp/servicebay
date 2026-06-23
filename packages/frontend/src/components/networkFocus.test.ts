/**
 * Network-map focus link helpers (#2108). Pure mapping between a service's
 * canonical unit name and the graph node id the Network Map focuses on.
 */
import { describe, it, expect } from 'vitest';
import {
  NETWORK_FOCUS_PARAM,
  networkFocusHref,
  matchesFocusParam,
  resolveFocusNodeId,
  planDeepLinkFocus,
} from './networkFocus';

describe('networkFocusHref (#2108)', () => {
  it('builds /network?focus=<encoded unit name>', () => {
    expect(networkFocusHref('immich.service')).toBe('/network?focus=immich.service');
    expect(NETWORK_FOCUS_PARAM).toBe('focus');
  });

  it('encodes names with special characters', () => {
    expect(networkFocusHref('a b.service')).toBe('/network?focus=a%20b.service');
  });

  it('falls back to the bare /network route when there is no name', () => {
    expect(networkFocusHref(undefined)).toBe('/network');
    expect(networkFocusHref('')).toBe('/network');
    expect(networkFocusHref('   ')).toBe('/network');
  });
});

describe('matchesFocusParam (#2108)', () => {
  it('matches the local service node id', () => {
    expect(matchesFocusParam('service-immich.service', 'immich.service')).toBe(true);
  });

  it('matches the remote-host-prefixed node id', () => {
    expect(matchesFocusParam('box2:service-immich.service', 'immich.service')).toBe(true);
  });

  it('does not match a different service or a substring', () => {
    expect(matchesFocusParam('service-immich-extra.service', 'immich.service')).toBe(false);
    expect(matchesFocusParam('service-other.service', 'immich.service')).toBe(false);
    expect(matchesFocusParam('service-immich.service', '')).toBe(false);
  });
});

describe('resolveFocusNodeId (#2108)', () => {
  const ids = ['internet', 'service-immich.service', 'box2:service-paperless.service'];

  it('resolves a local service param to its node id', () => {
    expect(resolveFocusNodeId(ids, 'immich.service')).toBe('service-immich.service');
  });

  it('resolves a remote service param to its prefixed node id', () => {
    expect(resolveFocusNodeId(ids, 'paperless.service')).toBe('box2:service-paperless.service');
  });

  it('returns null for a stale link (no matching node) or no param', () => {
    expect(resolveFocusNodeId(ids, 'gone.service')).toBeNull();
    expect(resolveFocusNodeId(ids, null)).toBeNull();
    expect(resolveFocusNodeId(ids, undefined)).toBeNull();
  });
});

describe('planDeepLinkFocus (#2108)', () => {
  const ids = ['internet', 'service-immich.service'];

  it('plans to focus a fresh, resolvable param', () => {
    expect(planDeepLinkFocus(ids, 'immich.service', null)).toEqual({
      nodeId: 'service-immich.service',
      appliedParam: 'immich.service',
      clearApplied: false,
    });
  });

  it('is a no-op once the param has already been applied (manual focus stays)', () => {
    expect(planDeepLinkFocus(ids, 'immich.service', 'immich.service')).toEqual({
      nodeId: null,
      appliedParam: null,
      clearApplied: false,
    });
  });

  it('does not focus (but records nothing) when the param matches no node', () => {
    expect(planDeepLinkFocus(ids, 'gone.service', null)).toEqual({
      nodeId: null,
      appliedParam: null,
      clearApplied: false,
    });
  });

  it('signals clearApplied when there is no focus param (so a later re-link re-applies)', () => {
    expect(planDeepLinkFocus(ids, null, 'immich.service')).toEqual({
      nodeId: null,
      appliedParam: null,
      clearApplied: true,
    });
  });
});
