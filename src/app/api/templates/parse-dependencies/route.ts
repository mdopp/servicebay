import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseTemplateDependencies } from '@/lib/stackInstall/dependencies';
import { ParseDependenciesRequestSchema } from '@/contracts/install';

export const dynamic = 'force-dynamic';

/**
 * Server-side install-time dependency parser. Phase 2 of the FE/BE
 * separation (#759): the frontend no longer imports
 * `@/lib/stackInstall/dependencies`. It POSTs raw template yaml and
 * gets back the `servicebay.dependencies` annotation's contents.
 *
 * Empty array on missing / blank annotation — matches the existing
 * `parseTemplateDependencies` contract.
 */
export const POST = withApiHandler({ body: ParseDependenciesRequestSchema }, async ({ body }) => {
  const dependencies = parseTemplateDependencies(body.yaml);
  return NextResponse.json({ dependencies });
});
