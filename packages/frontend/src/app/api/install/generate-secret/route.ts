import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { DEVICE_SAFE_SECRET_LENGTH, generateRandomSecret } from '@/lib/stackInstall/randomSecret';
import { GenerateSecretRequestSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

/**
 * Server-side random-secret generator. Phase 2 of the FE/BE
 * separation (#759): the frontend no longer imports
 * `@/lib/stackInstall/randomSecret`. It POSTs here when the install
 * flow needs to seed a `type: 'secret'` variable, or when the
 * operator clicks the regenerate button in `StackVariableField`.
 *
 * The function itself is portable (`crypto.getRandomValues` exists in
 * both runtimes), but the policy is that secret-generation lives
 * server-side as a logic primitive.
 */
export const POST = withApiHandler({ body: GenerateSecretRequestSchema }, async ({ body }) => {
  // #2577 — the regenerate button on a `deviceSafe` variable must mint the
  // same shape the install path does, or the operator regenerates their way
  // back into a value their device truncates. An explicit `length` still
  // wins; the flag only supplies the default.
  const secret = generateRandomSecret(
    body.length ?? (body.deviceSafe ? DEVICE_SAFE_SECRET_LENGTH : undefined),
  );
  return NextResponse.json({ secret });
});
