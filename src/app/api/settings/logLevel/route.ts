import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { updateConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const LogLevel = z.enum(['debug', 'info', 'warn', 'error']);
const PutBody = z.object({ logLevel: LogLevel });

/**
 * Log-level GET/PUT (#603 / ARCH-14 settings cluster migration).
 *
 * Returns `{ success: true, logLevel }` rather than wrapping in the
 * canonical `{ ok, data }` envelope so existing callers
 * (`LogLevelControl.tsx`, `LogViewer.tsx`) don't need to change. The
 * handler still buys us Zod validation, requireSession on PUT, and
 * uniform error shape.
 */
export const GET = withApiHandler({}, async () => {
  return NextResponse.json({ success: true, logLevel: logger.getLogLevel() });
});

export const PUT = withApiHandler({ body: PutBody }, async ({ body }) => {
  logger.setLogLevel(body.logLevel);
  logger.info('API', `Log level changed to: ${body.logLevel}`);
  await updateConfig({ logLevel: body.logLevel });
  return NextResponse.json({ success: true, logLevel: logger.getLogLevel() });
});
