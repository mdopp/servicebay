import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const tags = logger.getTags();
        return NextResponse.json({
            success: true,
            tags
        });
    } catch (err) {
        console.error('Failed to list tags:', err);
        return NextResponse.json({ success: false, tags: [] }, { status: 500 });
    }
}
