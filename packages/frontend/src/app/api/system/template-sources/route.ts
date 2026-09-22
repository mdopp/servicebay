import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { addTemplateSource, TemplateSourceError } from '@/lib/services/templateSources';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  url: z.string().min(1).max(512),
  name: z.string().max(64).optional(),
  branch: z.string().max(128).optional(),
});

/**
 * POST /api/system/template-sources — register a repo as a template source.
 *
 * `tokenScope: 'mutate'`, the tier that already covers installing a template:
 * this writes `config.registries` and then clones the repo. It is the step that
 * was missing between "I built a project" and "the box can install it" — the
 * only path before was the cookie-only onboarding route, which never adds an
 * item at all, so a new project meant hand-editing `config.json` on the box.
 *
 * The answer reports what the registry sync actually did, not that a line was
 * written. A source that is unreachable, private or carries no templates looks
 * identical in the config to one that works, and "added" on its own would be
 * exactly the silent success the rest of this surface has been cleaned of.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'mutate' },
  async ({ body }) => {
    try {
      return NextResponse.json(await addTemplateSource(body));
    } catch (error) {
      if (error instanceof TemplateSourceError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      logger.error('api:system:template-sources', `registering ${body.url} failed`, error);
      return NextResponse.json({ error: 'internal server error' }, { status: 500 });
    }
  },
);
