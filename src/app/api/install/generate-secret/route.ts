import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { generateRandomSecret } from '@/lib/stackInstall/randomSecret';
import { GenerateSecretRequestSchema } from '@/contracts/install';

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
  const secret = generateRandomSecret(body.length);
  return NextResponse.json({ secret });
});
