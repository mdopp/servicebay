import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';
import { summarizeCredentialSecurity, type Credential } from '@/lib/stackInstall/credentialsManifest';
import { syncCredentialsToVault } from '@/lib/vaultwarden/sync';

export const dynamic = 'force-dynamic';

/**
 * Vaultwarden push (#2519) — the automated counterpart to the manual
 * hand-off in `../secured/route.ts`.
 *
 * POST runs the push: every not-yet-secured entry is written into the
 * ServiceBay organization collection, **read back and decrypted**, and
 * only then does ServiceBay drop its own copy of that password. Repeats
 * update the existing item (identity is the `servicebay-id` field), so a
 * re-install or a rotation never grows a duplicate.
 *
 * The response always carries a summary, success or not — a failed or
 * partial push leaves the affected entries unsecured, which is what the
 * UI then shows. `ok: false` is a normal outcome here, not an exception:
 * "Vaultwarden isn't set up / is unreachable" is a state, not a crash.
 */
export const POST = withApiHandler({}, async () => {
  const result = await syncCredentialsToVault({ trigger: 'settings' });
  const config = await getConfig();
  const summary = summarizeCredentialSecurity((config.installManifest?.credentials ?? []) as Credential[]);
  return NextResponse.json({ ...result, summary });
});
