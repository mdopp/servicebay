import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const dates = logger.listLogDates();
    return NextResponse.json({
      success: true,
      // Map to structure expected by frontend (name/path) or just array of dates
      files: dates.map(date => ({
        name: date,
        // No path needed really, but keeping shape for now
        path: date
      }))
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', 'Failed to list log dates:', err);
    return NextResponse.json({
      success: false,
      error: message
    }, { status: 500 });
  }
}
