import { describe, it, expect } from 'vitest';
import {
  buildServiceDependencyMap,
  makePrerequisiteContext,
  resolvePrerequisiteChecks,
  resolvePrerequisitesTransitive,
  isRootCause,
  enumerateDownstreamFailing,
  renderCausalChainEmail,
  serviceOfCheck,
  type ServiceDependencyMap,
} from './prerequisiteChecks';
import type { CheckConfig, CheckResult } from './types';
import type { ProxyHostEntry } from '../config';

const chk = (over: Partial<CheckConfig> & Pick<CheckConfig, 'id' | 'type'>): CheckConfig => ({
  name: over.id,
  target: '',
  interval: 60,
  enabled: true,
  created_at: 't',
  ...over,
});

// Mirror the real topology: gateway ping, NPM, Authelia container, two
// public-domain feature services (immich, vaultwarden) each fronted by SSO.
const gateway = chk({ id: 'gw', type: 'ping', name: 'Internet Gateway', target: '192.168.178.1' });
const npmAuth = chk({ id: 'npm_auth', type: 'npm_auth', target: 'Local', name: 'NPM admin auth' });
const autheliaSvc = chk({ id: 'svc-authelia', type: 'service', target: 'authelia', name: 'Service: authelia' });
const immichSvc = chk({ id: 'svc-immich', type: 'service', target: 'immich', name: 'Service: immich' });
const immichDomain = chk({
  id: 'domain:photos.dopp.cloud', type: 'domain', target: 'photos.dopp.cloud', name: 'Domain — photos',
  domainConfig: { expectedScheme: 'https', isPublic: true },
});
const vaultDomain = chk({
  id: 'domain:vault.dopp.cloud', type: 'domain', target: 'vault.dopp.cloud', name: 'Domain — vault',
  domainConfig: { expectedScheme: 'https', isPublic: true },
});

const hosts: ProxyHostEntry[] = [
  { domain: 'photos.dopp.cloud', service: 'immich', forwardPort: 1, created: true },
  { domain: 'vault.dopp.cloud', service: 'vaultwarden', forwardPort: 2, created: true },
];

const serviceDeps: ServiceDependencyMap = buildServiceDependencyMap([
  { name: 'authelia', tier: 'infrastructure' },
  { name: 'nginx', tier: 'infrastructure' },
  { name: 'immich', tier: 'feature', dependencies: [] },
  { name: 'vaultwarden', tier: 'feature', dependencies: [] },
]);

const allChecks = [gateway, npmAuth, autheliaSvc, immichSvc, immichDomain, vaultDomain];

const ctxWith = (failingIds: string[]) =>
  makePrerequisiteContext({
    checks: allChecks,
    serviceDeps,
    config: { reverseProxy: { hosts } },
    isFailing: (id) => failingIds.includes(id),
  });

describe('buildServiceDependencyMap', () => {
  it('gives every feature an implicit edge to every infra stack', () => {
    expect(serviceDeps.get('immich')?.sort()).toEqual(['authelia', 'nginx']);
    expect(serviceDeps.get('authelia')).toEqual([]); // infra has no implicit edges
  });
});

describe('resolvePrerequisiteChecks', () => {
  it('maps a public domain → gateway + NPM + Authelia + its container + dep containers', () => {
    const prereqs = resolvePrerequisiteChecks(immichDomain, ctxWith([]));
    expect(prereqs).toContain('gw');           // internet (technical edge)
    expect(prereqs).toContain('npm_auth');     // public domain → NPM
    expect(prereqs).toContain('svc-authelia'); // SSO + infra dep
    expect(prereqs).toContain('svc-immich');   // its own container
    expect(prereqs).not.toContain(immichDomain.id);
  });

  it('npm_auth depends on Authelia', () => {
    expect(resolvePrerequisiteChecks(npmAuth, ctxWith([]))).toContain('svc-authelia');
  });

  it('the gateway ping has no prerequisites (it is a true root)', () => {
    expect(resolvePrerequisiteChecks(gateway, ctxWith([]))).toEqual([]);
  });
});

describe('isRootCause', () => {
  it('a domain check is NOT a root when the gateway is also failing', () => {
    expect(isRootCause(immichDomain, ctxWith(['gw', immichDomain.id]))).toBe(false);
  });

  it('the gateway IS the root when everything downstream is failing', () => {
    expect(isRootCause(gateway, ctxWith(['gw', immichDomain.id, vaultDomain.id]))).toBe(true);
  });

  it('a domain check IS a root when no prerequisite is failing', () => {
    expect(isRootCause(immichDomain, ctxWith([immichDomain.id]))).toBe(true);
  });

  it('Authelia is the root, the SSO domains are suppressed', () => {
    const ctx = ctxWith(['svc-authelia', immichDomain.id, vaultDomain.id]);
    expect(isRootCause(autheliaSvc, ctx)).toBe(true);
    expect(isRootCause(immichDomain, ctx)).toBe(false);
    expect(isRootCause(vaultDomain, ctx)).toBe(false);
  });
});

describe('serviceOfCheck — template http/script slug binding (#1663)', () => {
  // home-assistant ships an `http` API probe whose id slug leads with the
  // service name; the service itself has a container check.
  const haSvc = chk({ id: 'svc-home-assistant', type: 'service', target: 'home-assistant', name: 'Service: home-assistant' });
  const haApi = chk({ id: 'home-assistant-api', type: 'http', target: 'http://ha:8123', name: 'home-assistant-api' });
  const ollamaSvc = chk({ id: 'svc-ollama', type: 'service', target: 'ollama', name: 'Service: ollama' });
  const ollamaApi = chk({ id: 'ollama-api', type: 'http', target: 'http://ollama:11434', name: 'ollama-api' });
  const bareScript = chk({ id: 'ollama', type: 'script', target: 'echo', name: 'ollama' });
  const orphanApi = chk({ id: 'nonexistent-api', type: 'http', target: 'http://x', name: 'nonexistent-api' });

  const ctx = makePrerequisiteContext({
    checks: [haSvc, haApi, ollamaSvc, ollamaApi, bareScript, orphanApi],
    serviceDeps: new Map(),
    config: undefined,
    isFailing: () => false,
  });

  it('binds an http probe to its owning service via the longest slug prefix', () => {
    // home-assistant-api → home-assistant (not "home"); the hyphenated
    // service name must win the longest-prefix match.
    expect(serviceOfCheck(haApi, ctx)).toBe('home-assistant');
    expect(serviceOfCheck(ollamaApi, ctx)).toBe('ollama');
  });

  it('binds a bare-slug script probe to a same-named service', () => {
    expect(serviceOfCheck(bareScript, ctx)).toBe('ollama');
  });

  it('returns null when no container-checked service owns the slug', () => {
    expect(serviceOfCheck(orphanApi, ctx)).toBeNull();
  });

  it('an http probe gets its service container check as a prerequisite', () => {
    expect(resolvePrerequisiteChecks(haApi, ctx)).toContain('svc-home-assistant');
  });

  it('a container outage makes the http probe a downstream symptom, not a root', () => {
    const failingCtx = makePrerequisiteContext({
      checks: [haSvc, haApi],
      serviceDeps: new Map(),
      config: undefined,
      isFailing: (id) => id === 'svc-home-assistant' || id === 'home-assistant-api',
    });
    // container check is the root; the API probe collapses under it.
    expect(isRootCause(haApi, failingCtx)).toBe(false);
    expect(isRootCause(haSvc, failingCtx)).toBe(true);
  });
});

describe('cycle safety', () => {
  it('does not loop on a self/mutual cycle', () => {
    const a = chk({ id: 'a', type: 'service', target: 'a' });
    const b = chk({ id: 'b', type: 'service', target: 'b' });
    const cyclic: ServiceDependencyMap = new Map([['a', ['b']], ['b', ['a']]]);
    const ctx = makePrerequisiteContext({
      checks: [a, b], serviceDeps: cyclic, config: undefined, isFailing: () => true,
    });
    expect(() => resolvePrerequisitesTransitive(a, ctx)).not.toThrow();
    expect(resolvePrerequisitesTransitive(a, ctx).has('b')).toBe(true);
    expect(() => isRootCause(a, ctx)).not.toThrow();
  });
});

describe('enumerateDownstreamFailing + renderCausalChainEmail', () => {
  it('walks edges downward from the gateway to the failing leaf services', () => {
    const ctx = ctxWith(['gw', immichDomain.id, vaultDomain.id]);
    const downstream = enumerateDownstreamFailing('gw', ctx).map(c => c.id);
    expect(downstream).toContain(immichDomain.id);
    expect(downstream).toContain(vaultDomain.id);
  });

  it('renders a service-centered causal-chain email for an internet outage', () => {
    const ctx = ctxWith(['gw', immichDomain.id, vaultDomain.id]);
    const result: CheckResult = { check_id: 'gw', status: 'fail', timestamp: '2026-06-04T14:32:10Z', message: 'no route' };
    const { subject, body } = renderCausalChainEmail(gateway, result, ctx);
    expect(subject).toContain('root cause: no internet');
    expect(subject).toMatch(/2 services unreachable/);
    expect(body).toContain('Affected:');
    expect(body).toContain('immich');
    expect(body).toContain('vaultwarden');
    expect(body).toContain('the Internet Gateway (ping 192.168.178.1)');
    expect(body).toContain('since 14:32');
  });

  it('attributes an SSO outage to Authelia', () => {
    const ctx = ctxWith(['svc-authelia', immichDomain.id, vaultDomain.id]);
    const result: CheckResult = { check_id: 'svc-authelia', status: 'fail', timestamp: '2026-06-04T09:00:00Z' };
    const { subject, body } = renderCausalChainEmail(autheliaSvc, result, ctx);
    expect(subject).toContain('Authelia (SSO) down');
    expect(body).toContain('Authelia (SSO)');
  });
});
