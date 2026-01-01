import { NextResponse } from 'next/server';
import { MonitoringStore } from '@/lib/monitoring/store';
import { CheckConfig } from '@/lib/monitoring/types';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  const checks = MonitoringStore.getChecks();
  // Enrich with last result
  const enrichedChecks = checks.map(check => {
    const results = MonitoringStore.getResults(check.id);
    const lastResult = results[0];
    
    // Get last 20 results for sparkline/heartbeat
    const history = results.slice(0, 20).map(r => ({
        status: r.status,
        latency: r.latency,
        timestamp: r.timestamp
    }));

    return {
      ...check,
      status: lastResult ? lastResult.status : 'unknown',
      lastRun: lastResult ? lastResult.timestamp : null,
      lastResult: lastResult ? lastResult.message : null,
      history
    };
  });
  return NextResponse.json(enrichedChecks);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // If ID is provided, it's an update (or we are respecting the ID)
    // Otherwise generate a new one
    const check: CheckConfig = {
      id: body.id || uuidv4(),
      created_at: body.created_at || new Date().toISOString(),
      enabled: body.enabled !== undefined ? body.enabled : true,
      name: body.name,
      type: body.type,
      target: body.target,
      interval: body.interval || 60,
      httpConfig: body.httpConfig
    };
    
    MonitoringStore.saveCheck(check);
    return NextResponse.json(check);
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  
  if (!id) {
    return NextResponse.json({ error: 'ID required' }, { status: 400 });
  }

  MonitoringStore.deleteCheck(id);
  return NextResponse.json({ success: true });
}
