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
import { parseTemplateTier } from '@/lib/templateTier';
import { parseTemplateLabel } from '@/lib/templateLabel';
import { getTemplateUserGuide } from '@/lib/registry';
import { logger } from '@/lib/logger';
import { parseUserGuide, type PortalIconName, type RecommendedApp, type SetupAsset } from './userGuide';

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
  /** External URL the "Open" button should point at. */
  url: string;
  /** Markdown body shared across all cards from the same template
   *  (the template's `user-guide.md` body). */
  body: string;
  recommendedApps: RecommendedApp[];
  setupAssets: SetupAsset[];
}

/** Read a template's variables.json (best-effort, returns empty record on miss). */
async function readVariables(templateName: string): Promise<Record<string, { type?: string; default?: string }>> {
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
  const scheme = getMode(config) === 'public' ? 'https' : 'http';
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

  // Prefer a created proxy-host entry. The wizard's `buildProxyHosts`
  // derives `service` per subdomain variable: lowercase `<NAME>` from
  // `<NAME>_SUBDOMAIN`. Match against that so operator-customized
  // subdomains (e.g. `agenda` instead of `caldav` for Radicale) get
  // honoured even when the install renamed away from the default.
  const expectedService = chosenVar.replace(/_SUBDOMAIN$/i, '').toLowerCase();
  const hostEntry = (config.reverseProxy?.hosts ?? []).find(
    h => h.created && h.service === expectedService,
  );
  if (hostEntry) {
    return `${scheme}://${hostEntry.domain}`;
  }

  // Fallback: template default subdomain + active domain.
  return `${scheme}://${sub}.${getActiveDomain(config)}`;
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
      }];

    for (const def of cardDefs) {
      const url = await resolveServiceUrl(config, svc.name, def.subdomain_var || undefined);
      if (!url) {
        logger.warn('portal', `Template ${svc.name} card (subdomain_var=${def.subdomain_var || '<auto>'}) couldn't resolve a URL — skipping`);
        continue;
      }
      const subdomainVar = def.subdomain_var || (await firstSubdomainVar(svc.name)) || '';
      cards.push({
        id: `${svc.name}:${subdomainVar || 'default'}`,
        name: svc.name,
        subdomainVar,
        label: def.label ?? templateLabel,
        lucideIcon: def.lucide_icon ?? null,
        icon: def.icon ?? '',
        tagline: def.tagline ?? '',
        url,
        body: parsed.body,
        recommendedApps: def.recommended_apps ?? [],
        setupAssets: def.setup_assets ?? [],
      });
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
