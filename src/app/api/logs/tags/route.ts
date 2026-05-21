import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async () => {
  try {
    const tags = logger.getTags();
    return NextResponse.json({
      success: true,
      tags,
    });
  } catch (err) {
    logger.error('api:logs:tags', 'Failed to list tags', err);
    return NextResponse.json({ success: false, tags: [] }, { status: 500 });
  }
});
