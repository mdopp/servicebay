import { NextResponse } from 'next/server';
import { logger, LogFilter, LogLevel } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const filter: LogFilter = {
            date: url.searchParams.get('date') || undefined,
            level: (url.searchParams.get('level') as LogLevel) || undefined,
            tags: url.searchParams.getAll('tag'),
            search: url.searchParams.get('search') || undefined,
            limit: parseInt(url.searchParams.get('limit') || '500'),
            offset: parseInt(url.searchParams.get('offset') || '0')
        };
        
        const logs = logger.queryLogs(filter);
        return NextResponse.json({
            success: true,
            logs
        });
    } catch (err) {
        console.error('Failed to query logs:', err);
        return NextResponse.json({ success: false, logs: [] }, { status: 500 });
    }
}
