
import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const nodeName = searchParams.get('node') || 'Local';

    try {
        const agent = agentManager.getAgent(nodeName);
        if (!agent) {
             return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
        }
        
        // Use V4 'listContainers' command
        const list = await agent.sendCommand('listContainers');
        return NextResponse.json(list || []);
    } catch (e) {
        return apiError(e, { tag: 'api:containers:get', status: 500 });
    }
}
