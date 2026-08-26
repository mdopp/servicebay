/**
 * Health-check MCP tools (#2384 extraction): the check registry (list/create/
 * delete) plus the on-demand runner.
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';
// #2534 — the MCP health surface must be no weaker than the HTTP one. A check's
// `target` is not inert: every probe feeds it somewhere (an argv for the
// systemctl/podman probes, a URL the box fetches for `http`). The REST route
// `POST /api/health/checks` parses it with the shared `HealthCheckTarget`; this
// tool used a bare `z.string()`, so a mutate-scope token could send content a
// web session could not. Reuse the SAME shared schemas rather than a second
// idiom, so the rejection happens in the tool schema before any handler runs.
//
// #2535 — the one sink that was an *evaluator* (`type: "script"`, interpolated
// into `vm.runInContext`) is gone: the probe is deleted and the type is off the
// enum below, so this tool can no longer store one.
import { HealthCheckTarget, NodeName } from '@/lib/api/schemas';
import { HealthStore } from '@/lib/health/store';
import { getDiagnoseChecksEnriched, runDiagnoseChecks } from '@/lib/diagnose/diagnoseChecks';
// #2654/#2655 — the write verbs resolve an id through the SAME readers
// `get_health_checks` merges, so a listed id is never rejected and an unlisted
// one is rejected identically by every verb. See lib/health/checkLookup.ts.
import { resolveCheckId, checkNotFoundMessage } from '@/lib/health/checkLookup';
import { CheckRunner } from '@/lib/health/runner';
import type { CheckConfig, CheckType } from '@/lib/health/types';
import { textResult, errorResult, type ToolRegistration } from './context';

const checkTypeSchema = z.enum([
  'http', 'ping', 'podman', 'service', 'systemd', 'fritzbox', 'node', 'agent', 'backup',
]);

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerHealthTools({ server }: ToolRegistration) {
  // --- Get Health Checks ---
  server.tool(
    'get_health_checks',
    'List all health checks with their latest results, including the self-diagnose probe rows (backup coverage, TLS, DNS, …) the dashboard shows.',
    {},
    async () => {
      const checks = HealthStore.getChecks();
      const result = checks.map(check => ({
        ...check,
        lastResult: HealthStore.getLastResult(check.id),
      }));
      // #2615: `/api/health/checks` folds the synthetic `diagnose:<probeId>`
      // rows in at read time, this tool did not — so every diagnose-backed
      // signal was present on the dashboard and absent over MCP. That is how
      // "no backup check exists anywhere" looked true when the probes did
      // exist. Same reader, same rows, so the two surfaces cannot drift.
      return textResult([...result, ...getDiagnoseChecksEnriched()]);
    },
  );

  server.tool(
    'create_health_check',
    'Create a new health check (HTTP, ping, container, service, …). Returns the created check including generated id.',
    {
      name: z.string().min(1).describe('Display name'),
      type: checkTypeSchema.describe('Check type. The former "script" (custom JavaScript) type was removed (#2535) — it evaluated the target inside the ServiceBay backend process; use "http" instead.'),
      target: HealthCheckTarget.describe('URL / IP / container id / service name depending on type. Shell metacharacters are rejected — the same rule POST /api/health/checks applies.'),
      interval: z.number().int().min(10).max(86400).describe('Interval in seconds (10s–24h)'),
      enabled: z.boolean().optional().describe('Default: true'),
      nodeName: NodeName.optional().describe('Node to run the check from (default: first available)'),
      httpExpectedStatus: z.number().int().optional().describe('For type=http: expected HTTP status'),
      httpBodyMatch: z.string().optional().describe('For type=http: substring or regex the response body must match'),
    },
    async ({ name, type, target, interval, enabled, nodeName, httpExpectedStatus, httpBodyMatch }) => {
      const check: CheckConfig = {
        id: randomUUID(),
        name,
        type: type as CheckType,
        target,
        interval,
        enabled: enabled ?? true,
        created_at: new Date().toISOString(),
        nodeName,
        ...(type === 'http' && (httpExpectedStatus || httpBodyMatch)
          ? {
              httpConfig: {
                expectedStatus: httpExpectedStatus,
                bodyMatch: httpBodyMatch,
                bodyMatchType: 'contains',
              },
            }
          : {}),
      };
      HealthStore.saveCheck(check);
      return textResult(check);
    },
  );

  server.tool(
    'delete_health_check',
    'Delete a health check by id (use get_health_checks to find ids). A synthetic `diagnose:<probeId>` row is not a stored check, so deleting one is a documented no-op (`deleted: false`) rather than an error — it is a projection of the probe\'s persisted results; use run_check_now to refresh it.',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const resolved = resolveCheckId(id);
      if (resolved.kind === 'unknown') return errorResult(checkNotFoundMessage(id));
      if (resolved.kind === 'diagnose') {
        // #2655: get_health_checks lists this row, so answering "no such check"
        // contradicts the tool the caller just read. It is equally wrong to
        // answer `{deleted: id}` — nothing was deleted and the row reappears on
        // the next read (HealthStore.deleteCheck's own docstring warns about
        // exactly that fake success). So: succeed, and say what happened.
        return textResult({
          id,
          deleted: false,
          kind: 'diagnose',
          probeId: resolved.probeId,
          note: 'Diagnose rows are projected from persisted probe results, not stored in checks.json, '
            + 'so there is nothing to delete. Re-run the probe with run_check_now to refresh the finding; '
            + 'the row ages out on its own once results stop being written.',
        });
      }
      HealthStore.deleteCheck(id);
      return textResult({ deleted: id });
    },
  );

  server.tool(
    'run_check_now',
    'Run a health check immediately and persist the result. Returns the FRESH result. Accepts any id get_health_checks lists, including the synthetic `diagnose:<probeId>` rows — those re-execute the diagnose suite as a manual re-run (the same path as the dashboard\'s per-row Run button) and return that probe\'s newly persisted result, so a fixed finding clears without waiting for the daily tick.',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const resolved = resolveCheckId(id);
      if (resolved.kind === 'unknown') return errorResult(checkNotFoundMessage(id));
      try {
        if (resolved.kind === 'diagnose') {
          // #2655/#1709: `manual: true` is what makes reader probes over
          // expensive checks actually re-verify instead of re-displaying the
          // stored report — without it this returns a "fresh" result that is
          // the stale finding again. runDiagnose side-writes each probe result
          // (#1540), so the row is already persisted when we read it back.
          const results = await runDiagnoseChecks('Local', { manual: true });
          const fresh = results.find(r => r.check_id === id);
          if (!fresh) {
            return errorResult(
              `Diagnose probe "${resolved.probeId}" did not report a result on this run — `
              + 'it may no longer be registered. Call get_health_checks again for the current rows.',
            );
          }
          return textResult(fresh);
        }
        const result = await CheckRunner.run(resolved.check);
        HealthStore.saveResult(result);
        return textResult(result);
      } catch (err) {
        return errorResult(`Check run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
