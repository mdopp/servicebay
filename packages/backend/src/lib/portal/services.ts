/**
 * Server-side helpers that build the /portal card list (#242).
 *
 * Walks the digital twin to find running services, intersects with
 * templates that ship `user-guide.md`, and assembles the per-card
 * payload (icon, tagline, URL, mobile-app links, markdown body).
 *
 * Infrastructure-tier templates (`servicebay.tier: "infrastructure"`,
 * D19-PR1) are filtered out — the portal is for end-user-facing
 * services, not the platform plumbing.
 *
 * URL derivation in v1: each template's `variables.json` is searched
 * for a `subdomain`-typed variable; its `default` becomes the
 * subdomain. Combined with `getActiveDomain(config)` that gives a
 * URL like `http://photos.home.arpa` (LAN mode) or
 * `https://photos.<publicDomain>` (public mode). Doesn't yet honour
 * operator-customized subdomains — that's a follow-up once we
 * persist resolved subdomain values into config.
 */

import path from 'path';
import fs from 'fs/promises';
import { getConfig, type AppConfig } from '@/lib/config';
import { getActiveDomain, getMode } from '@/lib/mode';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getServices } from '@/lib/store/repository';
import { HealthStore } from '@/lib/health/store';
import { parseTemplateTier } from '@/lib/templateTier';
import { parseTemplateLabel } from '@/lib/templateLabel';
import { getTemplateUserGuide } from '@/lib/registry';
import { logger } from '@/lib/logger';
import { parseUserGuide, type PortalIconName, type RecommendedApp, type SetupAsset, type ManualPairing, type PortalAction } from './userGuide';

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');

export interface PortalCard {
  /** Stable id, e.g. "media:ABS_SUBDOMAIN" or "immich:IMMICH_SUBDOMAIN".
   *  Used as React key + lets multi-service templates emit one card
   *  per subdomain (#242 follow-up). */
  id: string;
  /** Template name (e.g. "media"). Used for asset endpoint paths. */
  name: string;
  /** Subdomain-variable name on the template (`*_SUBDOMAIN`). The
   *  asset endpoint uses this to resolve the right URL when the
   *  template has multiple subdomains (e.g. media → ABS_SUBDOMAIN
   *  for the Audiobookshelf card). */
  subdomainVar: string;
  /** User-facing label */
  label: string;
  /** Lucide icon name */
  lucideIcon: PortalIconName | null;
  /** Legacy emoji icon */
  icon: string;
  tagline: string;
  /** External URL the "Open" button should point at. Empty string for
   *  an appless card (no subdomain) — the CTA falls back to
   *  `primaryAction` instead (#1618). */
  url: string;
  /** Primary action for a URL-less service (#1618). When `url` is empty
   *  this is the card's CTA (a terminal deep-link, a `vscode://` link,
   *  …). Null for ordinary Open-URL cards. */
  primaryAction: PortalAction | null;
  /** Secondary actions rendered as extra buttons. Desktop-only ones
   *  (e.g. `vscode://`) carry `desktop_only` so the phone UI hides them. */
  secondaryActions: PortalAction[];
  /** Markdown body shared across all cards from the same template
   *  (the template's `user-guide.md` body). */
  body: string;
  recommendedApps: RecommendedApp[];
  setupAssets: SetupAsset[];
  /** Static "manual action required" steps — inherently-interactive
   *  pairing the operator runs by hand (e.g. `signal-cli link`).
   *  Informational only; the portal shows the command, not a runner. */
  manualPairing: ManualPairing[];
  /** Coarse up/down status (#1654), derived server-side at page load from
   *  the signals that already exist: the digital twin's per-service
   *  health probe (`serviceHealth[node][service].ready`), the auto-created
   *  domain-reachability check in HealthStore, and pod-active state.
   *    - `down`     — pod inactive OR the reachability/health probe failing.
   *    - `degraded` — running but some-but-not-all signals are unhealthy
   *                   (or the service reports `degraded: true`).
   *    - `ok`       — every present signal is healthy.
   *    - `unknown`  — no signal yet (no probe registered, no domain check). */
  status: PortalCardStatus;
  /** Optional short reason for a non-ok status. Kept generic — the portal
   *  is anonymous-readable (LAN), so this carries no sensitive detail. */
  statusReason?: string;
}

export type PortalCardStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** The signals `deriveCardStatus` folds into a coarse status. Each is
 *  optional — a missing signal contributes nothing (it can't make the
 *  status worse), so a service with no probe + no domain check is
 *  `unknown` rather than falsely `down`. */
export interface CardStatusSignals {
  /** Pod-active state (`ServiceManager.listServices().active`). */
  podActive?: boolean;
  /** The twin's `serviceHealth[node][service].ready` (health poller). */
  twinReady?: boolean;
  /** The twin's soft-fail flag — running but `degraded: true`. */
  twinDegraded?: boolean;
  /** Last domain-reachability check result (`ok`/`fail`); absent when no
   *  domain check exists for this card's URL. */
  domainOk?: boolean;
}

/**
 * Fold the available signals into a single coarse {@link PortalCardStatus}
 * (#1654). Pure — no I/O, so it's unit-testable in isolation.
 *
 * Rules:
 *   - `down`     — pod is explicitly inactive, OR a hard signal (domain
 *                  reachability / twin readiness) is failing.
 *   - `degraded` — the service reports `degraded: true`, or the signals
 *                  disagree (some healthy, some failing) without a hard
 *                  down.
 *   - `ok`       — at least one signal is present and every present
 *                  signal is healthy.
 *   - `unknown`  — no signal at all.
 */
export function deriveCardStatus(
  signals: CardStatusSignals,
): { status: PortalCardStatus; statusReason?: string } {
  // A pod that's explicitly not active is unambiguously down.
  if (signals.podActive === false) {
    return { status: 'down', statusReason: 'Not running' };
  }

  const present: boolean[] = [];
  if (signals.twinReady !== undefined) present.push(signals.twinReady);
  if (signals.domainOk !== undefined) present.push(signals.domainOk);

  if (present.length === 0) {
    return { status: 'unknown' };
  }

  const anyFail = present.some(ok => !ok);
  const allFail = present.every(ok => !ok);

  if (allFail) {
    const reason = signals.domainOk === false ? 'Not reachable' : 'Health check failing';
    return { status: 'down', statusReason: reason };
  }
  if (anyFail) {
    return { status: 'degraded', statusReason: 'Partially unhealthy' };
  }
  // Every present hard signal is healthy — soft-fail still shows degraded.
  if (signals.twinDegraded) {
    return { status: 'degraded', statusReason: 'Running in a degraded state' };
  }
  return { status: 'ok' };
}

/** Read a template's variables.json (best-effort, returns empty record on miss).
 *
 *  Includes `proxyPort` so `resolveServiceUrl` can discriminate
 *  multi-subdomain templates (HA + Z-Wave JS, ABS + Navidrome) by
 *  forwardPort — `buildProxyHosts` shares the `service` field
 *  across every host within a template, so a service-name match is
 *  ambiguous. See `resolveServiceUrl` for the lookup. */
async function readVariables(templateName: string): Promise<Record<string, { type?: string; default?: string; proxyPort?: string }>> {
  try {
    const content = await fs.readFile(path.join(TEMPLATES_PATH, templateName, 'variables.json'), 'utf-8');
    return JSON.parse(content);
  } catch { return {}; }
}

/** Read a template's template.yml (best-effort). */
async function readTemplateYaml(templateName: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(TEMPLATES_PATH, templateName, 'template.yml'), 'utf-8');
  } catch { return null; }
}

/**
 * Build the externally-reachable scheme (http/https) based on mode.
 */
function resolveServiceScheme(config: AppConfig): string {
  return getMode(config) === 'public' ? 'https' : 'http';
}

/**
 * Resolve the externally-reachable URL for a service. Used by both
 * the portal card builder (Open button) and the asset generators
 * (iOS profile hostname, abs:// deep link).
 *
 * Lookup order:
 *   1. `config.reverseProxy.hosts[]` — install-time proxy host
 *      entries reflect *exactly* what got deployed (operator's
 *      customized subdomain, the right TLD for the install mode).
 *      Match by service name.
 *   2. Template default subdomain + active domain — fallback for
 *      LAN-mode installs that don't create NPM proxy hosts, and
 *      for cards whose proxy entry is missing for any reason.
 *
 * Returns null when no template subdomain variable exists either —
 * matches the "skip this card" path in the caller.
 */
export async function resolveServiceUrl(
  config: AppConfig,
  templateName: string,
  /** Optional explicit *_SUBDOMAIN variable name. Required for
   *  multi-subdomain templates (media has both ABS_SUBDOMAIN and
   *  NAVIDROME_SUBDOMAIN); when omitted, falls back to the first
   *  subdomain variable in variables.json (single-subdomain case). */
  subdomainVar?: string,
): Promise<string | null> {
  const scheme = resolveServiceScheme(config);
  const variables = await readVariables(templateName);

  // Resolve which variable to read.
  let chosenVar = subdomainVar;
  if (!chosenVar) {
    chosenVar = Object.keys(variables).find(
      k => k.endsWith('_SUBDOMAIN') && variables[k].type === 'subdomain',
    );
  }
  if (!chosenVar) return null;
  const sub = variables[chosenVar]?.default;
  if (typeof sub !== 'string' || !sub) return null;

  // Prefer a created proxy-host entry. Match by the variable's
  // `proxyPort` (resolved to a number) — `buildProxyHosts` writes
  // `service: <templateName>` on every host in the same template,
  // which means single-template/multi-subdomain pods (home-assistant
  // has HA + ZWAVE_JS + MATTER, media has ABS + NAVIDROME) all share
  // a `service` value and can't be discriminated by it. The Home
  // Assistant portal card was opening `zwave.<domain>` instead of
  // `home.<domain>` because the legacy `service === <expected>`
  // match never hit and the fallback picked the first-listed
  // subdomain variable. Same root cause family as the LLDAP
  // deep-link bug fixed in #554.
  //
  // `proxyPort` can be a literal port string ("8123") or a variable
  // name ("ABS_PORT"); resolve both. Operator-customized port values
  // (via reconfigure) land in templateSettings — use those when
  // present, else fall back to the schema default.
  const proxyPortRaw = variables[chosenVar]?.proxyPort;
  let forwardPort: number | null = null;
  if (proxyPortRaw) {
    const direct = Number(proxyPortRaw);
    if (Number.isFinite(direct) && direct > 0) {
      forwardPort = direct;
    } else {
      // Treat as a variable reference; look up its current value.
      const refValue =
        config.templateSettings?.[proxyPortRaw] ?? variables[proxyPortRaw]?.default;
      const indirect = Number(refValue);
      if (Number.isFinite(indirect) && indirect > 0) forwardPort = indirect;
    }
  }
  const hosts = config.reverseProxy?.hosts ?? [];
  const hostEntry = hosts.find(h =>
    h.created && (
      // Primary: port-based discriminator (works for multi-subdomain templates).
      (forwardPort !== null && h.forwardPort === forwardPort)
      // Fallback: legacy single-subdomain match — keeps installs that
      // pre-date `templateName` injection working.
      || h.service === chosenVar.replace(/_SUBDOMAIN$/i, '').toLowerCase()
    ),
  );
  if (hostEntry) {
    return `${scheme}://${hostEntry.domain}`;
  }

  // Fallback: template default subdomain + active domain.
  return `${scheme}://${sub}.${getActiveDomain(config)}`;
}

interface PortalCardDef {
  subdomain_var: string;
  label?: string;
  lucide_icon?: PortalIconName;
  icon?: string;
  tagline?: string;
  recommended_apps?: RecommendedApp[];
  setup_assets?: SetupAsset[];
  manual_pairing?: ManualPairing[];
  primary_action?: PortalAction;
  actions?: PortalAction[];
}

/** Assemble the PortalCard payload once the URL + subdomainVar are
 *  resolved. Pure — no I/O — so the branching `buildPortalCardEntry`
 *  stays lean. */
function assemblePortalCard(
  def: PortalCardDef,
  serviceName: string,
  templateLabel: string,
  url: string | null,
  subdomainVar: string,
  parsedBody: string,
  status: { status: PortalCardStatus; statusReason?: string },
): PortalCard {
  return {
    id: `${serviceName}:${subdomainVar || 'default'}`,
    name: serviceName,
    subdomainVar,
    label: def.label ?? templateLabel,
    lucideIcon: def.lucide_icon ?? null,
    icon: def.icon ?? '',
    tagline: def.tagline ?? '',
    url: url ?? '',
    primaryAction: def.primary_action ?? null,
    secondaryActions: def.actions ?? [],
    body: parsedBody,
    recommendedApps: def.recommended_apps ?? [],
    setupAssets: def.setup_assets ?? [],
    manualPairing: def.manual_pairing ?? [],
    status: status.status,
    ...(status.statusReason ? { statusReason: status.statusReason } : {}),
  };
}

/** Extract the bare host (no scheme/path) from a resolved card URL so we
 *  can look up its `domain:<host>` health check. Returns null for an
 *  empty/appless URL. */
function hostFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Gather the per-service status signals from the already-available
 *  stores (the twin's service-health side-map + the HealthStore domain
 *  check) and fold them into a coarse status. */
function resolveCardStatus(
  podActive: boolean,
  serviceName: string,
  url: string | null,
  twinHealthByService: Map<string, { ready: boolean; degraded?: boolean }>,
): { status: PortalCardStatus; statusReason?: string } {
  const twin = twinHealthByService.get(serviceName);
  const host = hostFromUrl(url);
  const domainResult = host ? HealthStore.getLastResult(`domain:${host}`) : null;
  return deriveCardStatus({
    podActive,
    twinReady: twin?.ready,
    twinDegraded: twin?.degraded,
    domainOk: domainResult ? domainResult.status === 'ok' : undefined,
  });
}

/**
 * Build a single portal card entry from a parsed definition.
 */
async function buildPortalCardEntry(
  config: AppConfig,
  svc: Awaited<ReturnType<typeof ServiceManager.listServices>>[number],
  def: PortalCardDef,
  templateLabel: string,
  parsedBody: string,
  twinHealthByService: Map<string, { ready: boolean; degraded?: boolean }>,
): Promise<PortalCard | null> {
  const url = await resolveServiceUrl(config, svc.name, def.subdomain_var || undefined);
  // No subdomain URL: an appless card still renders *iff* the guide
  // declares an explicit primary action (#1618) — that becomes the CTA
  // in place of the Open-URL button. Without one, there's nothing to
  // act on, so we skip as before.
  if (!url && !def.primary_action) {
    logger.warn('portal', `Template ${svc.name} card (subdomain_var=${def.subdomain_var || '<auto>'}) couldn't resolve a URL and has no primary_action — skipping`);
    return null;
  }
  const subdomainVar = def.subdomain_var || (await firstSubdomainVar(svc.name)) || '';
  const status = resolveCardStatus(svc.active, svc.name, url, twinHealthByService);
  return assemblePortalCard(def, svc.name, templateLabel, url, subdomainVar, parsedBody, status);
}

/**
 * Build the portal-card list. Async because it walks per-template
 * files; cheap enough to run on every /portal request (which is
 * already gated by mode).
 *
 * Caller is responsible for the mode check. This function only does
 * card assembly.
 */
export async function buildPortalCards(node: string = 'Local'): Promise<PortalCard[]> {
  const services = await ServiceManager.listServices(node).catch(() => []);
  const running = services.filter(s => s.active);
  if (running.length === 0) return [];

  const config = await getConfig();

  // Snapshot the twin's per-service health once (the side-map is
  // re-attached onto `services[].health` on every agent sync — see
  // store/twin.ts). Keyed by service name so each card reads its probe
  // result without re-walking the node.
  const twinHealthByService = new Map<string, { ready: boolean; degraded?: boolean }>();
  for (const unit of getServices(node)) {
    if (unit.health) {
      twinHealthByService.set(unit.name, { ready: unit.health.ready, degraded: unit.health.degraded });
    }
  }

  const cards: PortalCard[] = [];
  for (const svc of running) {
    const yaml = await readTemplateYaml(svc.name);
    if (!yaml) continue; // Service whose template isn't on disk — skip
    const tier = parseTemplateTier(yaml);
    if (tier === 'infrastructure') continue;

    const rawGuide = await getTemplateUserGuide(svc.name).catch(() => null);
    const parsed = parseUserGuide(rawGuide, svc.name);
    if (!parsed) continue; // No guide → not on the portal in v1

    const templateLabel = parseTemplateLabel(yaml) ?? svc.name;

    // Multi-card templates: emit one card per `cards[]` entry. Single-
    // service templates: synthesize one implicit card from top-level
    // frontmatter (legacy path).
    const cardDefs = parsed.frontmatter.cards
      ?? [{
        // Implicit single card — use the first *_SUBDOMAIN variable.
        subdomain_var: '',
        lucide_icon: parsed.frontmatter.lucide_icon,
        icon: parsed.frontmatter.icon,
        tagline: parsed.frontmatter.tagline,
        recommended_apps: parsed.frontmatter.recommended_apps,
        setup_assets: parsed.frontmatter.setup_assets,
        manual_pairing: parsed.frontmatter.manual_pairing,
        primary_action: parsed.frontmatter.primary_action,
        actions: parsed.frontmatter.actions,
      }];

    for (const def of cardDefs) {
      const card = await buildPortalCardEntry(config, svc, def, templateLabel, parsed.body, twinHealthByService);
      if (card) cards.push(card);
    }
  }
  return cards;
}

/** Helper for the implicit-card path — find the first `*_SUBDOMAIN`
 *  variable name so the resulting PortalCard can record it. */
async function firstSubdomainVar(templateName: string): Promise<string | null> {
  const variables = await readVariables(templateName);
  for (const [name, meta] of Object.entries(variables)) {
    if (meta.type === 'subdomain' && name.endsWith('_SUBDOMAIN')) return name;
  }
  return null;
}
