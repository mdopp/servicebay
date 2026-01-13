import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { listNodes } from '@/lib/nodes';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Get all configured nodes
    const nodes = await listNodes();
    const nodeNames = nodes.map(n => n.Name);
    
    // Add Local if not already present
    if (!nodeNames.includes('Local')) {
      nodeNames.push('Local');
    }
    
    // Collect health from all agents
    const health = nodeNames.map(nodeName => {
      const agent = agentManager.getAgent(nodeName);
      return agent.getHealth();
    });
    
    return NextResponse.json({
      success: true,
      timestamp: Date.now(),
      agents: health
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('API', 'Failed to get system health:', err);
    return NextResponse.json({
      success: false,
      error: message
    }, { status: 500 });
  }
}
