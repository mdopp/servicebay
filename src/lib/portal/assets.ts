/**
 * Server-side generators for portal setup artifacts (#242 follow-up).
 *
 * Each setup_asset declared in a template's user-guide.md frontmatter
 * resolves to exactly one of these. The functions are pure given
 * config + service name; the API route at
 * `/api/portal/asset/[service]/[kind]` calls them and returns the
 * right Content-Type for download / link consumption.
 */

import crypto from 'crypto';
import { getActiveDomain, getMode } from '@/lib/mode';
import { getConfig, type AppConfig } from '@/lib/config';
import path from 'path';
import fs from 'fs/promises';
import type { SetupAssetKind } from './userGuide';

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');

/**
 * Read a service's `*_SUBDOMAIN` variable default from its
 * variables.json. Mirrors `pickSubdomainDefault` in services.ts;
 * lifted here to avoid a cross-module dep cycle.
 */
async function readSubdomainDefault(serviceName: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(TEMPLATES_PATH, serviceName, 'variables.json'), 'utf-8');
    const vars = JSON.parse(raw) as Record<string, { type?: string; default?: string }>;
    for (const [name, meta] of Object.entries(vars)) {
      if (meta.type === 'subdomain' && name.endsWith('_SUBDOMAIN') && typeof meta.default === 'string') {
        return meta.default;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Derive the externally-reachable URL for a given service in the
 * current install mode. Copies the lookup buildPortalCards uses so
 * assets see the same URL as the "Open" button.
 */
async function urlForService(config: AppConfig, serviceName: string): Promise<string | null> {
  const sub = await readSubdomainDefault(serviceName);
  if (!sub) return null;
  const domain = getActiveDomain(config);
  const scheme = getMode(config) === 'public' ? 'https' : 'http';
  return `${scheme}://${sub}.${domain}`;
}

/**
 * iOS Configuration Profile (.mobileconfig) that adds CalDAV +
 * CardDAV accounts pointing at the Radicale service. The user
 * downloads, taps to install in iOS Settings → General →
 * VPN & Device Management. iOS prompts for username + password
 * during install (we deliberately don't pre-fill those — family
 * member's password isn't ours to embed).
 *
 * Returns the XML as a string; the route handler sets the
 * `application/x-apple-aspen-config` Content-Type that triggers the
 * "Install Profile" prompt on download.
 */
export async function generateIosCalendarProfile(serviceName: string): Promise<string | null> {
  const config = await getConfig();
  const url = await urlForService(config, serviceName);
  if (!url) return null;
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const useSsl = parsed.protocol === 'https:';
  // iOS profile UUIDs: deterministic-ish per server so a re-install
  // updates the same profile rather than creating a duplicate.
  const seed = `servicebay:${hostname}:${serviceName}`;
  const profileUuid = `00000000-0000-0000-0000-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12)}`;
  const calUuid = `00000000-0000-0000-0000-${crypto.createHash('sha1').update(seed + ':cal').digest('hex').slice(0, 12)}`;
  const cardUuid = `00000000-0000-0000-0000-${crypto.createHash('sha1').update(seed + ':card').digest('hex').slice(0, 12)}`;

  // Note: PayloadIdentifier is the stable user-visible name. iOS
  // groups payloads by it; reusing `com.servicebay.<host>` means
  // re-installing the profile updates the same accounts rather
  // than duplicating them.
  const orgId = `com.servicebay.${hostname.replace(/\./g, '-')}`;

  // CalDAV / CardDAV "PrincipalURL" left empty — iOS will discover
  // it via the well-known endpoints CardDAV (.well-known/carddav)
  // and CalDAV (.well-known/caldav). Radicale supports both.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>CalDAVAccountDescription</key>
      <string>${escapeXml(hostname)} Calendar</string>
      <key>CalDAVHostName</key>
      <string>${escapeXml(hostname)}</string>
      <key>CalDAVUseSSL</key>
      <${useSsl ? 'true/' : 'false/'}>
      <key>PayloadDescription</key>
      <string>Connects iOS Calendar to your home server.</string>
      <key>PayloadDisplayName</key>
      <string>${escapeXml(hostname)} Calendar (CalDAV)</string>
      <key>PayloadIdentifier</key>
      <string>${orgId}.caldav</string>
      <key>PayloadOrganization</key>
      <string>ServiceBay</string>
      <key>PayloadType</key>
      <string>com.apple.caldav.account</string>
      <key>PayloadUUID</key>
      <string>${calUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
    <dict>
      <key>CardDAVAccountDescription</key>
      <string>${escapeXml(hostname)} Contacts</string>
      <key>CardDAVHostName</key>
      <string>${escapeXml(hostname)}</string>
      <key>CardDAVUseSSL</key>
      <${useSsl ? 'true/' : 'false/'}>
      <key>PayloadDescription</key>
      <string>Connects iOS Contacts to your home server.</string>
      <key>PayloadDisplayName</key>
      <string>${escapeXml(hostname)} Contacts (CardDAV)</string>
      <key>PayloadIdentifier</key>
      <string>${orgId}.carddav</string>
      <key>PayloadOrganization</key>
      <string>ServiceBay</string>
      <key>PayloadType</key>
      <string>com.apple.carddav.account</string>
      <key>PayloadUUID</key>
      <string>${cardUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Adds CalDAV + CardDAV accounts so iOS Calendar and Contacts sync with your home server. iOS will prompt for username + password during install.</string>
  <key>PayloadDisplayName</key>
  <string>${escapeXml(hostname)} Calendar &amp; Contacts</string>
  <key>PayloadIdentifier</key>
  <string>${orgId}.profile</string>
  <key>PayloadOrganization</key>
  <string>ServiceBay</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  return xml;
}

/**
 * Audiobookshelf deep link (`abs://...`). The official iOS / Android
 * apps register this scheme so opening the URL pre-configures the
 * server URL on a fresh install. If the app isn't installed, the
 * link silently fails on iOS (no-op) and offers to open the Play
 * Store on Android. The card UI labels this clearly so the user
 * knows it's an app-launch action.
 *
 * Format derived from Audiobookshelf's documented client deep link:
 * `abs://<host>?ssl=true|false`.
 */
export async function generateAudiobookshelfDeepLink(serviceName: string): Promise<string | null> {
  const config = await getConfig();
  const url = await urlForService(config, serviceName);
  if (!url) return null;
  const parsed = new URL(url);
  const ssl = parsed.protocol === 'https:' ? 'true' : 'false';
  return `abs://${parsed.host}?ssl=${ssl}`;
}

/** Resolve any setup-asset kind into its concrete artifact. */
export async function resolveSetupAsset(kind: SetupAssetKind, serviceName: string): Promise<{ kind: SetupAssetKind; data: string } | null> {
  switch (kind) {
    case 'ios_calendar_profile': {
      const xml = await generateIosCalendarProfile(serviceName);
      return xml ? { kind, data: xml } : null;
    }
    case 'audiobookshelf_deeplink': {
      const url = await generateAudiobookshelfDeepLink(serviceName);
      return url ? { kind, data: url } : null;
    }
  }
}

/** Tiny escape for XML attributes/text. Frontmatter is template-author
 *  input but service hostnames also flow through here, so be safe. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
