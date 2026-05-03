import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MonitoringStore } from '@/lib/monitoring/store';
import { CheckConfig } from '@/lib/monitoring/types';
import { v4 as uuidv4 } from 'uuid';
import { withApiHandler } from '@/lib/api/handler';
import { MonitoringCheckTarget, NodeName } from '@/lib/api/schemas';

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

const CheckPostBody = z.object({
  id: z.string().min(1).max(64).optional(),
  created_at: z.string().optional(),
  enabled: z.boolean().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['http', 'ping', 'script', 'podman', 'service', 'systemd', 'node', 'agent', 'fritzbox', 'backup']),
  target: MonitoringCheckTarget,
  interval: z.number().int().min(5).max(86400).optional(),
  nodeName: NodeName.optional(),
  httpConfig: z.object({
    expectedStatus: z.number().int().min(100).max(599).optional(),
    bodyMatch: z.string().optional(),
    bodyMatchType: z.enum(['contains', 'regex']).optional(),
  }).optional(),
});

export const POST = withApiHandler({ body: CheckPostBody }, async ({ body }) => {
  const check: CheckConfig = {
    id: body.id || uuidv4(),
    created_at: body.created_at || new Date().toISOString(),
    enabled: body.enabled !== undefined ? body.enabled : true,
    name: body.name,
    type: body.type,
    target: body.target,
    interval: body.interval || 60,
    nodeName: body.nodeName,
    httpConfig: body.httpConfig,
  };

  MonitoringStore.saveCheck(check);
  return check;
});

const CheckDeleteQuery = z.object({ id: z.string().min(1).max(64) });

export const DELETE = withApiHandler({ query: CheckDeleteQuery }, async ({ query }) => {
  MonitoringStore.deleteCheck(query.id);
  return { success: true };
});
