import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ file: string }> }
) {
  try {
    const { file } = await params;
    const decodedFile = decodeURIComponent(file);
    
    // Parse query parameters
    const url = new URL(_req.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const level = (url.searchParams.get('level') || undefined) as any;
    const tag = url.searchParams.get('tag') || undefined;
    const search = url.searchParams.get('search') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '1000', 10);
    
    const logs = logger.readLogs(decodedFile, level, tag, search);
    
    // Apply limit to most recent logs
    const limited = logs.slice(-limit);
    
    return NextResponse.json({
      success: true,
      file: decodedFile,
      count: limited.length,
      total: logs.length,
      logs: limited
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', 'Failed to read log file:', err);
    return NextResponse.json({
      success: false,
      error: message
    }, { status: 500 });
  }
}
