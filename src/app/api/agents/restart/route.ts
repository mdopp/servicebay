import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';

import { requireSession } from '@/lib/api/requireSession';
export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

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
