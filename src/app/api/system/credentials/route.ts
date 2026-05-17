import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, saveConfig, type InstalledCredential, type InstallManifest } from '@/lib/config';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

/**
 * Install-credentials manifest persistence (#19 / A1).
 *
 *   GET    — return the manifest stored at install time so the operator
 *            can copy/save it later without keeping the wizard open.
 *   POST   — replace the manifest. Called by the wizard at the end of
 *            an install run.
 *   DELETE — wipe the manifest. The "I saved these — wipe from server"
 *            action that narrows the post-install window of plaintext
 *            credentials sitting in config.json.
 *
 * The `password` field on each entry is auto-encrypted at rest by the
 * existing `SENSITIVE_KEYS` regex in lib/config.ts — same trust
 * boundary as the kube YAMLs that already embed plaintext secrets.
 *
 * Auth: same as every other /api/system route — proxy.ts gates on a
 * valid session cookie or the X-SB-Internal-Token header.
 */

const CredentialSchema = z.object({
  service: z.string().min(1).max(120),
  url: z.string().min(1).max(400),
  username: z.string().max(120),
  password: z.string().max(400),
  importance: z.enum(['critical', 'system']),
  notes: z.string().max(400).optional(),
});

const ManifestBody = z.object({
  credentials: z.array(CredentialSchema).max(64),
});

export async function GET() {
  const config = await getConfig();
  const manifest = config.installManifest;
  if (!manifest) {
    return NextResponse.json({ manifest: null });
  }
  // getConfig has already decrypted sensitive fields, so credentials
  // come back in plaintext for the same admin who just authenticated.
  return NextResponse.json({ manifest });
}

export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  let parsed;
  try {
    parsed = ManifestBody.parse(await request.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Invalid request body' },
      { status: 400 },
    );
  }
  const config = await getConfig();
  const manifest: InstallManifest = {
    savedAt: new Date().toISOString(),
    credentials: parsed.credentials as InstalledCredential[],
  };
  await saveConfig({ ...config, installManifest: manifest });
  return NextResponse.json({ ok: true, savedAt: manifest.savedAt, count: manifest.credentials.length });
}

export async function DELETE(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  const config = await getConfig();
  if (!config.installManifest) {
    return NextResponse.json({ ok: true, alreadyEmpty: true });
  }
  // Re-save with the field stripped. updateConfig deep-merges, so we
  // can't use it to delete a key — saveConfig with a copy minus the
  // field is the right primitive.
  const { installManifest, ...rest } = config;
  void installManifest;
  await saveConfig(rest);
  return NextResponse.json({ ok: true });
}
