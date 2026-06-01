import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HealthStore } from '@/lib/health/store';
import { CheckConfig } from '@/lib/health/types';
import { v4 as uuidv4 } from 'uuid';
import { withApiHandler } from '@/lib/api/handler';
import { HealthCheckTarget, NodeName } from '@/lib/api/schemas';
import { getDiagnoseChecksEnriched } from '@/lib/diagnose/diagnoseChecks';

export const GET = withApiHandler({}, async () => {
  const checks = HealthStore.getChecks();
  // Enrich with last result
  const enrichedChecks = checks.map(check => {
    const results = HealthStore.getResults(check.id);
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
  // #1423: fold the daily self-diagnose probes into the unified Checks
  // list. They live as synthetic `diagnose:<probeId>` result rows (never
  // in checks.json), so merge them in at read time.
  const diagnoseChecks = getDiagnoseChecksEnriched();
  return NextResponse.json([...enrichedChecks, ...diagnoseChecks]);
});

const CheckPostBody = z.object({
  id: z.string().min(1).max(64).optional(),
  created_at: z.string().optional(),
  enabled: z.boolean().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(['http', 'ping', 'script', 'podman', 'service', 'systemd', 'node', 'agent', 'fritzbox', 'backup']),
  target: HealthCheckTarget,
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

  HealthStore.saveCheck(check);
  return check;
});

const CheckDeleteQuery = z.object({ id: z.string().min(1).max(64) });

export const DELETE = withApiHandler({ query: CheckDeleteQuery }, async ({ query }) => {
  HealthStore.deleteCheck(query.id);
  return { success: true };
});
