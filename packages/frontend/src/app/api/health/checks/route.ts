import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HealthStore } from '@/lib/health/store';
import { CheckConfig, isCheckPending } from '@/lib/health/types';
import { v4 as uuidv4 } from 'uuid';
import { withApiHandler } from '@/lib/api/handler';
import { CheckIdString, HealthCheckTarget, NodeName } from '@/lib/api/schemas';
import { getDiagnoseChecksEnriched } from '@/lib/diagnose/diagnoseChecks';
import { buildServiceAttributionIndex, resolveDomainCheckService } from '@/lib/health/checkAttribution';
import { isKnownLocalSystemTarget } from '@/lib/health/ssrfGuard';

export const GET = withApiHandler({}, async () => {
  const checks = HealthStore.getChecks();
  // #2394: one attribution index per node touched by this batch (built from
  // the in-memory twin, so it costs no agent round trip). A `domain` check's
  // host / upstream port maps 1:1 to the service NPM forwards it to, so it
  // belongs on that service's Health tab rather than the box-wide list.
  const attribution = new Map<string, ReturnType<typeof buildServiceAttributionIndex>>();
  const indexFor = (nodeName: string) => {
    let index = attribution.get(nodeName);
    if (!index) {
      index = buildServiceAttributionIndex(nodeName);
      attribution.set(nodeName, index);
    }
    return index;
  };
  // Enrich with last result
  const enrichedChecks = checks.map(check => {
    const results = HealthStore.getResults(check.id);
    const lastResult = results[0];
    const serviceName = check.type === 'domain'
      ? resolveDomainCheckService(
          check.target,
          check.domainConfig?.upstreamPort,
          indexFor(check.nodeName || 'Local'),
        )
      : null;

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
      // #2166: a check created-but-never-run (within the grace window) is
      // "pending", not the same undifferentiated 'unknown' as a check that's
      // been silent for reasons other than being new. Lets the UI read a
      // brand-new check as "not run yet" instead of a suspicious blank.
      pending: isCheckPending(check.created_at, Boolean(lastResult)),
      // #2394: absent when nothing on the box claims the domain — an orphan
      // route IS a box-level finding, so it keeps its box-wide home instead
      // of silently disappearing from every tab.
      ...(serviceName ? { serviceName } : {}),
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
  // #2536: a check id is a *file name* — `HealthStore` builds the result file
  // as `<DATA_DIR>/results/<id>.json`. The shared `CheckIdString` is the one
  // rule for that field (the `[id]/history` and `[id]/run` sub-routes already
  // parse with it), so the character class can't drift between the four routes
  // that handle an id. The bare `z.string().min(1).max(64)` this replaced
  // allowed separators and `..`, i.e. a write outside DATA_DIR.
  id: CheckIdString.optional(),
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

export const POST = withApiHandler({ body: CheckPostBody }, async ({ body, auth }) => {
  // #1670: a ServiceBay self-created check of a known-local hostNetwork
  // service (HA `127.0.0.1:8123`, Ollama `:11434`) bypasses the monitoring
  // SSRF guard. Only the internal-token path (a stack's post-deploy, `auth.user
  // === 'internal'`) targeting a recognised loopback service earns the flag —
  // a user-supplied check (cookie session / UI) never does, so a user can't
  // self-grant the bypass for an arbitrary internal URL.
  const systemCheck =
    auth?.user === 'internal' &&
    body.type === 'http' &&
    isKnownLocalSystemTarget(body.target);

  // #2536: the id is minted server-side, exactly as the MCP `create_health_check`
  // tool already does with `randomUUID()`. An incoming id is honoured only as an
  // *upsert key* — never as a new on-disk path segment:
  //   - it names a check that already exists  → the UI's edit/save flow, which
  //     round-trips the row's own id; the results file is already there.
  //   - the caller is ServiceBay itself (`auth.user === 'internal'`, the same
  //     mechanism #1670 uses on this route) → a stack's post-deploy registering
  //     its stable slug id (`home-assistant-api`, `ollama-api`, #1551), which
  //     init.ts's orphan-prune keys on.
  // Anything else — including a session-authenticated body picking its own id —
  // gets a fresh UUID, so an untrusted caller cannot choose a file name at all.
  const requestedId = body.id;
  const isKnownId = requestedId !== undefined
    && HealthStore.getChecks().some(c => c.id === requestedId);
  const acceptRequestedId = requestedId !== undefined
    && (isKnownId || auth?.user === 'internal');

  const check: CheckConfig = {
    id: acceptRequestedId ? requestedId : uuidv4(),
    created_at: body.created_at || new Date().toISOString(),
    enabled: body.enabled !== undefined ? body.enabled : true,
    name: body.name,
    type: body.type,
    target: body.target,
    interval: body.interval || 60,
    nodeName: body.nodeName,
    httpConfig: body.httpConfig,
    ...(systemCheck ? { systemCheck: true } : {}),
  };

  HealthStore.saveCheck(check);
  return check;
});

// #2536: same one rule as the POST body and the two `[id]` sub-routes. This
// path only filters an in-memory list, so it has no traversal sink today —
// but a second, looser copy of the character class is exactly how the four
// id-handling routes drift apart again.
const CheckDeleteQuery = z.object({ id: CheckIdString });

export const DELETE = withApiHandler({ query: CheckDeleteQuery }, async ({ query }) => {
  // `Self-diagnose: …` rows are synthetic `diagnose:<probeId>` projections of the
  // live diagnose probes — never stored, so deleting them is impossible by design.
  // Say so honestly instead of returning a fake success that no-ops and lets the row
  // reappear on the next poll. It clears once the underlying probe passes.
  if (query.id.startsWith('diagnose:')) {
    return NextResponse.json(
      {
        ok: false,
        code: 'DIAGNOSE_NOT_DELETABLE',
        error:
          "This is a self-diagnose check — it reflects a live probe result, not a stored check, so it can't be deleted. It clears on its own once the underlying issue is resolved.",
      },
      { status: 400 },
    );
  }
  if (!HealthStore.deleteCheck(query.id)) {
    return NextResponse.json(
      { ok: false, code: 'CHECK_NOT_FOUND', error: `No deletable check with id "${query.id}".` },
      { status: 404 },
    );
  }
  return { success: true };
});
