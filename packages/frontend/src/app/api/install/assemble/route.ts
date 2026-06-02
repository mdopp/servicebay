import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { assembleManifest } from '@/lib/install/manifestAssembler';

export const dynamic = 'force-dynamic';

/**
 * Assemble a stack-install manifest server-side (#800).
 *
 * Takes a template selection + caller-supplied variable values and
 * returns a `{ items, variables }` pair ready to POST to
 * `/api/install/start`. The browser wizard's configure step calls this
 * instead of building the manifest itself; the same endpoint is what a
 * future headless / ISO-driven first-boot setup uses to turn baked
 * `config.json` defaults into an installable manifest.
 *
 * `tokenScope: 'lifecycle'` (#1276) lets the sb stack-install panel
 * assemble a manifest with a scoped `sb_` token; the paired
 * `/api/install/start` carries the same scope so one lifecycle token drives
 * the whole install.
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  try {
    const body = (await request.json()) as {
      items?: { name: string; checked: boolean; alreadyInstalled?: boolean }[];
      prefilled?: Record<string, string>;
      templateSource?: string;
    };
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'items must be a non-empty array' },
        { status: 400 },
      );
    }
    const manifest = await assembleManifest({
      items: body.items,
      prefilled: body.prefilled ?? {},
      // Omitted/empty source → undefined (walk every registry, then
      // built-in, per template) rather than a pinned 'Built-in' that
      // skips externals. Lets one assemble call span multiple sources
      // (#1177). The wizard always sends an explicit source, so its
      // behaviour is unchanged.
      templateSource:
        typeof body.templateSource === 'string' && body.templateSource
          ? body.templateSource
          : undefined,
    });
    return NextResponse.json(manifest);
  } catch (error) {
    return apiError(error, { tag: 'api:install:assemble', status: 500 });
  }
});
