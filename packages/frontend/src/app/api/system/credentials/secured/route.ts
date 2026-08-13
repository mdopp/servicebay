import { NextResponse } from 'next/server';
import { getConfig, saveConfig, type InstalledCredential, type InstallManifest } from '@/lib/config';
import {
  markCredentialsSecured,
  summarizeCredentialSecurity,
  type Credential,
} from '@/lib/stackInstall/credentialsManifest';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Vaultwarden hand-off confirmation (#2519).
 *
 * POST — record that every not-yet-secured credential now lives in the
 * operator's Vaultwarden vault, and **drop ServiceBay's copy of the
 * secret in the same write**. The entry itself stays: service, URL,
 * username and notes remain so Settings can still say *what* exists and
 * link to the vault — only `password` goes.
 *
 * This is deliberately the ONLY way an entry becomes "secured", and it
 * cannot be set without the drop happening (`markCredentialsSecured`
 * empties `password` as part of the same map). "Secured" and "we still
 * hold it" are therefore not simultaneously representable.
 *
 * Not the automated push the issue asks for — see the issue thread: a
 * server-side write into a *personal* Vaultwarden vault needs a
 * vault-unlocking secret, which ServiceBay must not hold. The state this
 * route writes is the same state an automated push would write, so the
 * push slice replaces the trigger without changing the model.
 */
export const POST = withApiHandler({}, async () => {
  const config = await getConfig();
  const existing = (config.installManifest?.credentials ?? []) as Credential[];
  if (existing.length === 0) {
    return NextResponse.json({ ok: true, secured: 0, summary: summarizeCredentialSecurity([]) });
  }

  const before = summarizeCredentialSecurity(existing);
  if (before.unsecured === 0) {
    return NextResponse.json({ ok: true, secured: 0, summary: before });
  }

  const securedAt = new Date().toISOString();
  const next = markCredentialsSecured(existing, securedAt);
  const manifest: InstallManifest = {
    savedAt: securedAt,
    credentials: next as unknown as InstalledCredential[],
  };
  await saveConfig({ ...config, installManifest: manifest });

  return NextResponse.json({
    ok: true,
    secured: before.unsecured,
    securedAt,
    summary: summarizeCredentialSecurity(next),
  });
});
