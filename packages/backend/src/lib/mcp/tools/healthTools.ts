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
  server.tool('get_health_checks', 'List all health checks with their latest results', {}, async () => {
    const checks = HealthStore.getChecks();
    const result = checks.map(check => ({
      ...check,
      lastResult: HealthStore.getLastResult(check.id),
    }));
    return textResult(result);
  });

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
    'Delete a health check by id (use get_health_checks to find ids).',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const before = HealthStore.getChecks().length;
      HealthStore.deleteCheck(id);
      const after = HealthStore.getChecks().length;
      if (before === after) return errorResult(`No check with id "${id}" found`);
      return textResult({ deleted: id });
    },
  );

  server.tool(
    'run_check_now',
    'Run a health check immediately and persist the result. Returns the result.',
    { id: z.string().min(1).describe('Check id') },
    async ({ id }) => {
      const check = HealthStore.getChecks().find(c => c.id === id);
      if (!check) return errorResult(`No check with id "${id}" found`);
      try {
        const result = await CheckRunner.run(check);
        HealthStore.saveResult(result);
        return textResult(result);
      } catch (err) {
        return errorResult(`Check run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
