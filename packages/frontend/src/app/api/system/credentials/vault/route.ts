import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, saveConfig, type CredentialVaultConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * The one door for configuring ServiceBay's Vaultwarden push account
 * (#2519).
 *
 * Write-only for the secret: the master password goes in here and is
 * never handed back out — `GET /api/system/credentials` returns only
 * whether an account is configured, and the value itself is encrypted at
 * rest (the field is named `password`, so it is inside `SENSITIVE_KEYS`).
 * An empty `password` on a subsequent save means "keep the stored one",
 * so re-pointing the collection does not require re-typing it.
 *
 * DELETE forgets the account. That does NOT un-secure anything already in
 * the vault — those entries' passwords are gone from ServiceBay by
 * design; it only stops future pushes.
 */
const VaultBody = z.object({
  accountEmail: z.string().email().max(200),
  password: z.string().max(400).optional(),
  organizationId: z.string().min(1).max(64),
  collectionId: z.string().min(1).max(64),
  baseUrl: z.string().url().max(300).optional().or(z.literal('')),
});

export const POST = withApiHandler({ body: VaultBody }, async ({ body }) => {
  const config = await getConfig();
  const existing = config.credentialVault;
  const password = body.password?.trim() || existing?.password || '';
  if (!password) {
    return NextResponse.json(
      { error: 'A master password for the ServiceBay vault account is required.' },
      { status: 400 },
    );
  }
  const credentialVault: CredentialVaultConfig = {
    accountEmail: body.accountEmail.trim(),
    password,
    organizationId: body.organizationId.trim(),
    collectionId: body.collectionId.trim(),
    ...(body.baseUrl ? { baseUrl: body.baseUrl.trim() } : {}),
    // A changed target invalidates the previous run's verdict.
    ...(existing?.lastSync && existing.accountEmail === body.accountEmail.trim()
      ? { lastSync: existing.lastSync }
      : {}),
  };
  await saveConfig({ ...config, credentialVault });
  return NextResponse.json({ ok: true, configured: true });
});

export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  if (!config.credentialVault) return NextResponse.json({ ok: true, configured: false });
  const { credentialVault, ...rest } = config;
  void credentialVault;
  await saveConfig(rest);
  return NextResponse.json({ ok: true, configured: false });
});
