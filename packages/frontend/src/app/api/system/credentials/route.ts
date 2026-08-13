import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, saveConfig, type AppConfig, type InstalledCredential, type InstallManifest } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import { isVaultwardenInstalled, syncCredentialsToVault } from '@/lib/vaultwarden/sync';

export const dynamic = 'force-dynamic';

/**
 * Install-credentials manifest persistence (#19 / A1, migrated to
 * withApiHandler in #603).
 *
 *   GET    — return the manifest stored at install time
 *   POST   — replace the manifest (wizard end-of-install)
 *   DELETE — wipe the manifest ("I saved these — wipe from server")
 *
 * The `password` field on each entry is auto-encrypted at rest by the
 * existing `SENSITIVE_KEYS` regex in lib/config.ts.
 */

const CredentialSchema = z.object({
  service: z.string().min(1).max(120),
  url: z.string().min(1).max(400),
  username: z.string().max(120),
  password: z.string().max(400),
  importance: z.enum(['critical', 'system']),
  notes: z.string().max(400).optional(),
  template: z.string().max(120).optional(),
  // #2519 — hand-off marker. Round-tripped so a caller that reads the
  // manifest and writes it back doesn't silently resurrect entries as
  // "not yet secured".
  securedAt: z.string().max(40).optional(),
});

const ManifestBody = z.object({
  credentials: z.array(CredentialSchema).max(64),
});

/**
 * Push state for the UI (#2519). Deliberately carries no secret: the
 * account e-mail and the org/collection ids are pointers, and
 * `credentialVault.password` is never read here.
 */
export function vaultStatus(config: AppConfig) {
  const v = config.credentialVault;
  return {
    installed: isVaultwardenInstalled(config),
    configured: Boolean(v?.accountEmail && v.password && v.organizationId && v.collectionId),
    /** Which account writes — a pointer, not a credential. */
    account: v?.accountEmail ?? null,
    lastSync: v?.lastSync ?? null,
  };
}

export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const manifest = config.installManifest;
  // Proxy-host map + public domain let the client resolve loopback URLs to
  // each console's public subdomain (#1626) and surface the Vaultwarden
  // import deep link (#1627) — without re-deriving any subdomain mapping.
  const proxyHosts = (config.reverseProxy?.hosts ?? []).map(h => ({
    domain: h.domain,
    service: h.service,
  }));
  const publicDomain = config.reverseProxy?.publicDomain ?? null;
  const vault = vaultStatus(config);
  if (!manifest) return NextResponse.json({ manifest: null, proxyHosts, publicDomain, vault });
  return NextResponse.json({ manifest, proxyHosts, publicDomain, vault });
});

export const POST = withApiHandler({ body: ManifestBody }, async ({ body }) => {
  const config = await getConfig();
  const manifest: InstallManifest = {
    savedAt: new Date().toISOString(),
    credentials: body.credentials as InstalledCredential[],
  };
  await saveConfig({ ...config, installManifest: manifest });
  // End-of-install write — the moment the freshly generated passwords
  // exist. Push them straight at Vaultwarden (#2519) rather than waiting
  // for an operator to notice. Not awaited: a vault that is down must not
  // fail an install, and every failure is already durable state (the
  // entry keeps its password and stays "not yet secured").
  void syncCredentialsToVault({ trigger: 'install-manifest' }).catch(e => {
    logger.warn('Credentials', `Vaultwarden push failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  return NextResponse.json({ ok: true, savedAt: manifest.savedAt, count: manifest.credentials.length });
});

export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  if (!config.installManifest) {
    return NextResponse.json({ ok: true, alreadyEmpty: true });
  }
  const { installManifest, ...rest } = config;
  void installManifest;
  await saveConfig(rest);
  return NextResponse.json({ ok: true });
});
