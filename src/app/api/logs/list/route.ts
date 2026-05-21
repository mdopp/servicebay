import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async () => {
  try {
    const dates = logger.listLogDates();
    return NextResponse.json({
      success: true,
      // Map to structure expected by frontend (name/path).
      files: dates.map(date => ({
        name: date,
        path: date,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', 'Failed to list log dates:', err);
    return NextResponse.json({
      success: false,
      error: message,
    }, { status: 500 });
  }
});
