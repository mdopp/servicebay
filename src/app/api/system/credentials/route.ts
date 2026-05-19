import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, saveConfig, type InstalledCredential, type InstallManifest } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

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
});

const ManifestBody = z.object({
  credentials: z.array(CredentialSchema).max(64),
});

export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const manifest = config.installManifest;
  if (!manifest) return NextResponse.json({ manifest: null });
  return NextResponse.json({ manifest });
});

export const POST = withApiHandler({ body: ManifestBody }, async ({ body }) => {
  const config = await getConfig();
  const manifest: InstallManifest = {
    savedAt: new Date().toISOString(),
    credentials: body.credentials as InstalledCredential[],
  };
  await saveConfig({ ...config, installManifest: manifest });
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
