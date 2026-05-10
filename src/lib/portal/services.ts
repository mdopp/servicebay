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
import { getConfig } from '@/lib/config';
import { getActiveDomain, getMode } from '@/lib/mode';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { parseTemplateTier } from '@/lib/templateTier';
import { parseTemplateLabel } from '@/lib/templateLabel';
import { getTemplateUserGuide } from '@/lib/registry';
import { logger } from '@/lib/logger';
import { parseUserGuide, type RecommendedApp } from './userGuide';

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');

export interface PortalCard {
  /** Template name (e.g. "immich"). Used as React key. */
  name: string;
  /** User-facing label (from frontmatter title fallback or `servicebay.label`). */
  label: string;
  /** Frontmatter icon emoji, or empty string. */
  icon: string;
  /** Frontmatter tagline, or empty string. */
  tagline: string;
  /** External URL the "Open" button should point at. */
  url: string;
  /** Markdown body for the expandable Getting-started section. May be empty. */
  body: string;
  /** Companion apps recommended by the template author (validated). */
  recommendedApps: RecommendedApp[];
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
 * Given a template's variables.json, pick the operator-facing
 * subdomain default. Heuristic: first variable whose `meta.type` is
 * `subdomain` and whose name ends in `_SUBDOMAIN`. Returns the
 * default value (e.g. `'photos'` for Immich's `IMMICH_SUBDOMAIN`),
 * or null when the template has no subdomain variable.
 */
function pickSubdomainDefault(variables: Record<string, { type?: string; default?: string }>): string | null {
  for (const [name, meta] of Object.entries(variables)) {
    if (meta.type === 'subdomain' && name.endsWith('_SUBDOMAIN') && typeof meta.default === 'string') {
      return meta.default;
    }
  }
  return null;
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
  const activeDomain = getActiveDomain(config);
  const mode = getMode(config);
  const scheme = mode === 'public' ? 'https' : 'http';

  const cards: PortalCard[] = [];
  for (const svc of running) {
    const yaml = await readTemplateYaml(svc.name);
    if (!yaml) continue; // Service whose template isn't on disk — skip
    const tier = parseTemplateTier(yaml);
    if (tier === 'infrastructure') continue;

    const rawGuide = await getTemplateUserGuide(svc.name).catch(() => null);
    const parsed = parseUserGuide(rawGuide, svc.name);
    if (!parsed) continue; // No guide → not on the portal in v1

    const variables = await readVariables(svc.name);
    const sub = pickSubdomainDefault(variables);
    if (!sub) {
      logger.warn('portal', `Template ${svc.name} has user-guide.md but no subdomain variable — skipping`);
      continue;
    }

    const label = parsed.frontmatter.tagline
      ? (parseTemplateLabel(yaml) ?? svc.name)
      : (parseTemplateLabel(yaml) ?? svc.name);
    cards.push({
      name: svc.name,
      label,
      icon: parsed.frontmatter.icon ?? '',
      tagline: parsed.frontmatter.tagline ?? '',
      url: `${scheme}://${sub}.${activeDomain}`,
      body: parsed.body,
      recommendedApps: parsed.frontmatter.recommended_apps ?? [],
    });
  }
  return cards;
}
