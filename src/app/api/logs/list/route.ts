import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const files = logger.listLogFiles();
    return NextResponse.json({
      success: true,
      files: files.map(file => ({
        name: file,
        path: `/api/logs/${encodeURIComponent(file)}`
      }))
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', 'Failed to list log files:', err);
    return NextResponse.json({
      success: false,
      error: message
    }, { status: 500 });
  }
}
