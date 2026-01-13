import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const currentLevel = logger.getLogLevel();
    return NextResponse.json({
      success: true,
      logLevel: currentLevel
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      success: false,
      error: message
    }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const { logLevel } = body;
    
    if (!logLevel) {
      return NextResponse.json({
        success: false,
        error: 'logLevel is required'
      }, { status: 400 });
    }
    
    logger.setLogLevel(logLevel);
    logger.info('API', `Log level changed to: ${logLevel}`);
    
    return NextResponse.json({
      success: true,
      logLevel: logger.getLogLevel()
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', 'Failed to update log level:', err);
    return NextResponse.json({
      success: false,
      error: message
    }, { status: 500 });
  }
}
