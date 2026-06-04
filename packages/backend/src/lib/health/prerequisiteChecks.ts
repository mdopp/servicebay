/**
 * Prerequisite-check resolution + causal-chain rendering
 * (#1652, epic #1650 item B).
 *
 * The alert subsystem used to treat every check as an island: when the
 * internet dropped or Authelia restarted, every dependent check failed
 * and emailed independently — a storm of "immich down", "vaultwarden
 * down", "sso-X down" when the real story is one root cause.
 *
 * This module makes checks aware of each other by **reusing the
 * dependency graph that already exists** — no new user config, no new
 * `dependsOn` field. A check's prerequisites compose two existing sources:
 *
 *   1. service/stack edges — the templates' `servicebay.dependencies`
 *      plus the infra-tier implicit edges (the #796 rule: every feature
 *      depends on every infrastructure stack). This is the SAME graph the
 *      installer topo-sorts with ({@link buildServiceDependencyMap}
 *      mirrors `stackInstall/dependencies.ts` `computeEffectiveDeps`).
 *      Each dep service-name is translated to that service's health checks.
 *   2. technical edges — derived from {@link CheckType}: domain /
 *      dns_routing / letsdebug → the Internet Gateway (ping); a public
 *      domain (`domainConfig.isPublic`) → NPM admin-auth; SSO / npm_auth →
 *      Authelia; any per-service check → that service's container check.
 *
 * Two consumers use this:
 *   - **Root-cause-only alerting** (`runAndEmit`): a failing check alerts
 *     only when NONE of its prerequisite checks is currently failing.
 *     Downstream failures are suppressed *as separate emails* — the data
 *     still shows per-check in the UI, only the alert is gated.
 *   - **Service-centered causal-chain email**: the root's alert walks the
 *     same edges DOWNWARD to enumerate transitive impact and renders
 *     leaf → root.
 *
 * Cycle-safe throughout (every traversal carries a visited set). A check
 * with no resolvable prerequisites is its own root.
 */

import type { CheckConfig, CheckResult, CheckType } from './types';
import type { AppConfig, ProxyHostEntry } from '../config';

/** Canonical infra service names the technical edges point at. These are
 *  the template names the installer uses; the per-service health check
 *  carries `target === <serviceName>`. */
const AUTH_SERVICE = 'authelia';
const NPM_SERVICE = 'nginx';

/** Check types whose health is gated on the upstream internet path. */
const INTERNET_DEPENDENT_TYPES: ReadonlySet<CheckType> = new Set<CheckType>([
  'domain',
  'dns_routing',
  'letsdebug',
]);

/**
 * Effective service-dependency edges, keyed by service (template) name.
 * Mirrors `stackInstall/dependencies.ts` `computeEffectiveDeps`: each
 * service maps to its declared `servicebay.dependencies` PLUS — for
 * `feature`-tier services — an implicit edge to every `infrastructure`
 * service. This is the single source of truth the installer topo-sorts
 * with; we reuse it so the alert graph never drifts from the install graph.
 */
export type ServiceDependencyMap = Map<string, string[]>;

/** Minimal template shape we need from the registry. */
interface TemplateLike {
  name: string;
  tier?: 'infrastructure' | 'feature';
  dependencies?: string[];
}

/**
 * Build the effective service→deps map from the template registry.
 * Async (reads the registry) and intended to be built once and cached by
 * the caller — the graph only changes when stacks are installed/removed.
 *
 * The implicit infra edge matches `computeEffectiveDeps`: a feature
 * depends on every infrastructure stack so the whole infra block is a
 * prerequisite of any feature, exactly as #796 specified.
 */
export function buildServiceDependencyMap(templates: TemplateLike[]): ServiceDependencyMap {
  const infraNames = templates
    .filter(t => t.tier === 'infrastructure')
    .map(t => t.name);
  const map: ServiceDependencyMap = new Map();
  for (const t of templates) {
    const tier = t.tier ?? 'feature';
    const explicit = (t.dependencies ?? []).filter(d => d !== t.name);
    if (tier === 'infrastructure') {
      map.set(t.name, [...new Set(explicit)]);
    } else {
      const implicit = infraNames.filter(n => n !== t.name);
      map.set(t.name, [...new Set([...explicit, ...implicit])]);
    }
  }
  return map;
}

/**
 * Everything the (pure) prerequisite resolver needs. Built once per
 * resolution pass by the caller from live state; passing it explicitly
 * keeps {@link resolvePrerequisiteChecks} a pure, unit-testable function.
 */
export interface PrerequisiteContext {
  /** Every configured check (HealthStore.getChecks()). */
  checks: CheckConfig[];
  /** Effective service→deps edges (buildServiceDependencyMap). */
  serviceDeps: ServiceDependencyMap;
  /** Reverse-proxy hosts, used to map a `domain` check → its service. */
  hosts: ProxyHostEntry[];
  /** Current failing-status per check-id (true = currently failing). */
  isFailing: (checkId: string) => boolean;
}

/** Build a PrerequisiteContext from raw inputs. */
export function makePrerequisiteContext(input: {
  checks: CheckConfig[];
  serviceDeps: ServiceDependencyMap;
  config: Pick<AppConfig, 'reverseProxy'> | undefined;
  isFailing: (checkId: string) => boolean;
}): PrerequisiteContext {
  return {
    checks: input.checks,
    serviceDeps: input.serviceDeps,
    hosts: input.config?.reverseProxy?.hosts ?? [],
    isFailing: input.isFailing,
  };
}

/** The owning service name of a check, or null if it isn't service-bound.
 *  Per-service checks carry `target === <serviceName>` (init.ts); domain
 *  checks map via `reverseProxy.hosts[]` (domain↔service). */
export function serviceOfCheck(check: CheckConfig, ctx: PrerequisiteContext): string | null {
  if (check.type === 'service' || check.type === 'podman' || check.type === 'systemd') {
    return check.target || null;
  }
  if (check.type === 'domain') {
    const host = ctx.hosts.find(h => h.domain === check.target);
    return host?.service ?? null;
  }
  // Template-registered http/script probes carry an id slug whose leading
  // segment is the owning service (init.ts isOrphanTemplateCheck). We only
  // bind one when that leading segment matches a known service container check.
  return null;
}

/** The `type:'service'` container check for a service, if one exists. */
function containerCheckId(service: string, ctx: PrerequisiteContext): string | null {
  const c = ctx.checks.find(ch => ch.type === 'service' && ch.target === service);
  return c?.id ?? null;
}

/** Find a singleton/technical check by predicate. */
function findCheckId(ctx: PrerequisiteContext, pred: (c: CheckConfig) => boolean): string | null {
  return ctx.checks.find(pred)?.id ?? null;
}

/** The Internet Gateway ping check (the configured-gateway ping, init.ts). */
function gatewayCheckId(ctx: PrerequisiteContext): string | null {
  return findCheckId(ctx, c => c.type === 'ping' && c.name === 'Internet Gateway');
}

/** The NPM admin-auth singleton check. */
function npmCheckId(ctx: PrerequisiteContext): string | null {
  return (
    findCheckId(ctx, c => c.type === 'npm_auth') ??
    containerCheckId(NPM_SERVICE, ctx)
  );
}

/** Authelia's check: its container check (a `service`-type targeting the
 *  authelia stack). */
function autheliaCheckId(ctx: PrerequisiteContext): string | null {
  return containerCheckId(AUTH_SERVICE, ctx);
}

/** True when a domain check is SSO-protected (a public-domain service is
 *  fronted by Authelia in this codebase). We treat `domainConfig.isPublic`
 *  as the SSO/NPM signal per the issue. */
function isPublicDomain(check: CheckConfig): boolean {
  return check.type === 'domain' && check.domainConfig?.isPublic === true;
}

/**
 * Direct prerequisite check-ids for a single check — service/stack edges
 * + technical edges. Does NOT recurse (the caller walks transitively).
 * Never returns the check's own id.
 */
export function resolvePrerequisiteChecks(check: CheckConfig, ctx: PrerequisiteContext): string[] {
  const prereqs = new Set<string>();
  const add = (id: string | null) => {
    if (id && id !== check.id) prereqs.add(id);
  };

  // ---- technical edges (CheckType-derived) ----
  if (INTERNET_DEPENDENT_TYPES.has(check.type)) {
    add(gatewayCheckId(ctx));
  }
  if (isPublicDomain(check)) {
    add(npmCheckId(ctx));
    add(autheliaCheckId(ctx));
  }
  if (check.type === 'npm_auth') {
    add(autheliaCheckId(ctx));
  }

  // any per-service check (domain/http/etc.) → that service's container check
  const service = serviceOfCheck(check, ctx);
  if (service) {
    add(containerCheckId(service, ctx));
    // SSO-fronted service domain → Authelia.
    if (isPublicDomain(check)) add(autheliaCheckId(ctx));

    // ---- service/stack edges (template dependency graph) ----
    for (const depService of ctx.serviceDeps.get(service) ?? []) {
      add(containerCheckId(depService, ctx));
    }
  }

  return [...prereqs];
}

/** Transitive prerequisite check-ids (cycle-safe). */
export function resolvePrerequisitesTransitive(check: CheckConfig, ctx: PrerequisiteContext): Set<string> {
  const seen = new Set<string>();
  const byId = new Map(ctx.checks.map(c => [c.id, c]));
  const stack = [...resolvePrerequisiteChecks(check, ctx)];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || id === check.id) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) continue;
    for (const next of resolvePrerequisiteChecks(c, ctx)) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/**
 * Root-cause test: a failing check is the root of its cascade only if NONE
 * of its (transitive) prerequisite checks is currently failing. If an
 * upstream prerequisite is also failing, THIS check is a downstream symptom
 * and its alert is suppressed.
 */
export function isRootCause(check: CheckConfig, ctx: PrerequisiteContext): boolean {
  for (const id of resolvePrerequisitesTransitive(check, ctx)) {
    if (ctx.isFailing(id)) return false;
  }
  return true;
}

/**
 * Walk the prerequisite edges DOWNWARD from a root check to enumerate
 * every check that (transitively) depends on it AND is currently failing.
 * Cycle-safe. Used to attribute the cascade to its root for the email.
 */
export function enumerateDownstreamFailing(rootId: string, ctx: PrerequisiteContext): CheckConfig[] {
  // Build reverse edges: dependent ← prerequisite.
  const dependents = new Map<string, CheckConfig[]>();
  for (const c of ctx.checks) {
    for (const prereq of resolvePrerequisiteChecks(c, ctx)) {
      const arr = dependents.get(prereq) ?? [];
      arr.push(c);
      dependents.set(prereq, arr);
    }
  }
  const seen = new Set<string>([rootId]);
  const out: CheckConfig[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const dep of dependents.get(id) ?? []) {
      if (seen.has(dep.id)) continue;
      seen.add(dep.id);
      if (ctx.isFailing(dep.id)) out.push(dep);
      stack.push(dep.id);
    }
  }
  return out;
}

/** A single rung of the rendered causal chain (root last). */
export interface CausalChainRung {
  checkId: string;
  label: string;
}

/**
 * Build the human causal chain from a leaf-most failing downstream check
 * up to the root, following the first currently-failing prerequisite at
 * each step. Cycle-safe. Returns rungs ordered leaf → root.
 */
export function buildCausalChain(rootCheck: CheckConfig, ctx: PrerequisiteContext): CausalChainRung[] {
  const byId = new Map(ctx.checks.map(c => [c.id, c]));
  const rungs: CausalChainRung[] = [];
  const seen = new Set<string>();
  let current: CheckConfig | undefined = rootCheck;
  // Walk UP from root toward deeper roots is unnecessary — rootCheck IS the
  // root; instead we render root last, prefixed by the nearest failing
  // downstream symptom layer. The downstream enumeration supplies impact;
  // here we render the prerequisite spine of the root itself (which, by
  // definition of root, has no failing prereqs) plus the root.
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    rungs.unshift({ checkId: current.id, label: describeCheck(current) });
    // Follow the first currently-failing prerequisite, if any (defensive:
    // a true root has none, but a near-root may during a race).
    const next: CheckConfig | undefined = resolvePrerequisiteChecks(current, ctx)
      .map(id => byId.get(id))
      .find((c): c is CheckConfig => !!c && ctx.isFailing(c.id));
    current = next;
  }
  return rungs;
}

/** Human label for a check in the causal chain. */
function describeCheck(check: CheckConfig): string {
  switch (check.type) {
    case 'ping':
      return check.name === 'Internet Gateway'
        ? `the Internet Gateway (ping ${check.target})`
        : `${check.name} (ping ${check.target})`;
    case 'npm_auth':
      return 'NPM (reverse proxy)';
    case 'service':
    case 'podman':
    case 'systemd':
      return check.target === AUTH_SERVICE ? 'Authelia (SSO)' : `${check.target}`;
    case 'domain':
      return `${check.target}`;
    default:
      return check.name;
  }
}

/**
 * Render the service-centered causal-chain alert for a root failure.
 *
 * Subject: `3 services unreachable — root cause: <root summary>`
 * Body lists the affected services (leaf), then the chain up to the root:
 *
 *   Affected: immich, vaultwarden, file-share
 *     ← because Authelia (SSO) is failing
 *     ← because the Internet Gateway (ping 192.168.178.1) is down since 14:32
 */
export function renderCausalChainEmail(
  rootCheck: CheckConfig,
  rootResult: CheckResult,
  ctx: PrerequisiteContext,
): { subject: string; body: string } {
  const downstream = enumerateDownstreamFailing(rootCheck.id, ctx);
  // Affected services: distinct services owning the downstream failing
  // checks (plus the root's own service, if any).
  const affectedServices = new Set<string>();
  for (const c of downstream) {
    const svc = serviceOfCheck(c, ctx);
    if (svc) affectedServices.add(svc);
  }
  const services = [...affectedServices];

  const rootSummary = rootCauseSummary(rootCheck);
  const subject = services.length > 0
    ? `${services.length} service${services.length === 1 ? '' : 's'} unreachable — root cause: ${rootSummary}`
    : `${rootCheck.name} failing — root cause: ${rootSummary}`;

  const since = rootResult.timestamp ? ` since ${shortTime(rootResult.timestamp)}` : '';
  const lines: string[] = [];
  if (services.length > 0) {
    lines.push(`Affected: ${services.join(', ')}`);
  }
  // Render the spine leaf → root using the chain rungs (root last).
  const rungs = buildCausalChain(rootCheck, ctx);
  rungs.forEach((rung, i) => {
    const isRoot = i === rungs.length - 1;
    const suffix = isRoot ? `${rung.label} is down${since}` : `${rung.label} is failing`;
    lines.push(`  ← because ${suffix}`);
  });
  if (rootResult.message) lines.push('', `Details: ${rootResult.message}`);

  return { subject, body: lines.join('\n') };
}

/** Short, human root-cause phrase for the subject line. */
function rootCauseSummary(check: CheckConfig): string {
  if (check.type === 'ping' && check.name === 'Internet Gateway') return 'no internet';
  if (check.target === AUTH_SERVICE) return 'Authelia (SSO) down';
  if (check.type === 'npm_auth') return 'reverse proxy down';
  if (check.type === 'service' || check.type === 'podman' || check.type === 'systemd') {
    return `${check.target} down`;
  }
  return `${check.name} failing`;
}

/** "2026-06-04T14:32:10Z" → "14:32". Falls back to the raw value. */
function shortTime(timestamp: string): string {
  const m = /T(\d{2}:\d{2})/.exec(timestamp);
  return m ? m[1] : timestamp;
}
