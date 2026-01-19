import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const nodeName = body?.nodeName || body?.node;
    const reason = body?.reason || 'manual';
    const config = await getConfig();
    const timeoutMs = (config.agent?.gracefulShutdownTimeout ?? 30) * 1000;

    if (nodeName) {
      await agentManager.restartAgent(nodeName, reason, timeoutMs);
    } else {
      await agentManager.restartAll(reason, timeoutMs);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
