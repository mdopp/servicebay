/**
 * GET /api/system/stacks/[name]/status (#634)
 *
 * Single-stack detail: parsed manifest + per-child health. Drives the
 * stack-detail view (StackCard).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { getStackManifest } from '@/lib/registry';
import { getStackHealth } from '@/lib/install/stackHealth';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const { name } = await ctx.params;
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

    let manifest;
    try {
      manifest = await getStackManifest(name);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'manifest parse failed' },
        { status: 500 },
      );
    }
    if (!manifest) {
      return NextResponse.json({ error: `Stack \`${name}\` has no manifest.` }, { status: 404 });
    }

    const health = await getStackHealth(name);
    return NextResponse.json({ name, manifest, health });
  } catch (e) {
    return apiError(e, { tag: 'api:system:stacks:status', status: 500 });
  }
}
