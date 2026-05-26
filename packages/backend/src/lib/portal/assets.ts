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
import { getConfig } from '@/lib/config';
import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import { resolveServiceUrl } from './services';
import type { SetupAssetKind } from './userGuide';

// Asset URLs go through the shared `resolveServiceUrl` helper so the
// iOS profile hostname + abs:// link always match what the portal's
// "Open" button renders. Avoids drift between the card URL and the
// asset URL when the operator customized a subdomain.

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
export async function generateIosCalendarProfile(serviceName: string, subdomainVar?: string): Promise<string | null> {
  const config = await getConfig();
  const url = await resolveServiceUrl(config, serviceName, subdomainVar);
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
export async function generateAudiobookshelfDeepLink(serviceName: string, subdomainVar?: string): Promise<string | null> {
  const config = await getConfig();
  const url = await resolveServiceUrl(config, serviceName, subdomainVar);
  if (!url) return null;
  const parsed = new URL(url);
  const ssl = parsed.protocol === 'https:' ? 'true' : 'false';
  return `abs://${parsed.host}?ssl=${ssl}`;
}

/**
 * Read the running Syncthing container's device ID via the Syncthing
 * CLI. Tries the v2 subcommand first (`syncthing device-id`), falling
 * back to the v1 flag form (`syncthing --device-id`) so a downgrade /
 * legacy image still works.
 *
 * The container name follows podman play-kube's `<pod>-<container>`
 * convention — the YAML's container is named `syncthing` but the
 * actual podman container is `file-share-syncthing`. Calling it
 * just by `syncthing` returns 404 and the UI ends up hiding the
 * QR with "Syncthing container might not be running yet".
 *
 * Syncthing v2.x dropped the `--device-id` flag in favour of a
 * `device-id` subcommand (observed live 2026-05-26 on a fresh
 * Syncthing v2.1.0 container — the old call returned `unknown flag
 * --device-id`, exit 80, which the portal's QR modal surfaced as a
 * 404). The shell `||` chain tries v2 first, falls back to v1.
 *
 * Returns `null` when the container isn't running, the agent
 * doesn't respond, or the parse fails — the caller treats that as
 * "asset not available, hide the button".
 */
export async function fetchSyncthingDeviceId(node: string = 'Local'): Promise<string | null> {
  try {
    const agent = await agentManager.ensureAgent(node);
    // The Syncthing CLI prints the device ID directly. We use it
    // because the config.xml's "ourselves" device ID requires
    // parsing the XML's myID attribute or matching against the
    // container's hostname; the CLI is one less moving part.
    const res = await agent.sendCommand('exec', {
      command: 'podman exec file-share-syncthing sh -c "syncthing device-id 2>/dev/null || syncthing --device-id 2>/dev/null"',
    }, { timeoutMs: 6_000 }) as { code?: number; stdout?: string };
    if (res.code !== 0) return null;
    const id = (res.stdout ?? '').trim();
    // Syncthing device IDs are 56 chars in 7 groups of 7 separated
    // by hyphens (e.g. ABCDEFG-HIJKLMN-...). Lightly validate so
    // a noisy stdout (warning lines, etc.) doesn't smuggle junk
    // into the QR.
    if (!/^[A-Z2-7]{7}(-[A-Z2-7]{7}){6}$/.test(id)) {
      logger.warn('portal:assets', `Unexpected syncthing device-id shape: ${id.slice(0, 40)}`);
      return null;
    }
    return id;
  } catch (e) {
    logger.warn('portal:assets', `Could not fetch syncthing device id: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Resolve any setup-asset kind into its concrete artifact. */
export async function resolveSetupAsset(
  kind: SetupAssetKind,
  serviceName: string,
  subdomainVar?: string,
): Promise<{ kind: SetupAssetKind; data: string } | null> {
  switch (kind) {
    case 'ios_calendar_profile': {
      const xml = await generateIosCalendarProfile(serviceName, subdomainVar);
      return xml ? { kind, data: xml } : null;
    }
    case 'audiobookshelf_deeplink': {
      const url = await generateAudiobookshelfDeepLink(serviceName, subdomainVar);
      return url ? { kind, data: url } : null;
    }
    case 'syncthing_qr': {
      const deviceId = await fetchSyncthingDeviceId('Local');
      return deviceId ? { kind, data: deviceId } : null;
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
