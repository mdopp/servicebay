/**
 * Last-mile reconciliation passes the install runner fires at the end
 * of a deploy loop, after every individual template's post-deploy
 * script has run.
 *
 * Per-template emits via the capability bus are the primary path —
 * each template's `feature.installed` event triggers handlers that
 * register the NPM proxy host, the Authelia OIDC client, etc. But the
 * per-template path is fragile: the auth or nginx pod may be
 * restarting between writes, or the emit may fire before the
 * dependency is reachable. When a single handler under-produces, the
 * operator hits "client not registered" or "subdomain returns NPM's
 * default page" the first time they open the service.
 *
 * The two passes below batch every template in this install through
 * one idempotent endpoint each, so anything the per-template emit
 * missed gets picked up by the time the wizard hands off to the
 * portal.
 *
 * Extracted from runner.ts in #975. The two functions previously
 * lived in the runner directly and are unchanged by the move — see
 * runner.test.ts for behaviour pinned by tests.
 */

import { getTemplateVariables } from '@/lib/registry';
import { buildProxyHosts, type StackVariable } from '@/lib/stackInstall/postInstall';
import { appendLog } from './jobStore';
import { emitJobLog } from './socketBridge';
import { getInternalApiToken } from '@/lib/auth/internalToken';

/** Best-effort jobStore log helper — mirrors the private one in runner.ts.
 *  Kept local so neither module has to import the other. */
async function log(jobId: string, line: string): Promise<void> {
  await appendLog(jobId, line);
  emitJobLog(jobId, line);
}

/** Loopback fetch helper. Attaches the internal API token so the proxy.ts
 *  CSRF gate accepts state-changing calls coming from this Node process
 *  (no session cookie, no Origin header). Mirrors the helper in runner.ts. */
function apiFetch(p: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers });
}

/**
 * Last-mile guard for per-service NPM proxy hosts. Walks the stack
 * variables for `type: subdomain` entries and creates one proxy host
 * per subdomain. The endpoint is idempotent — anything an earlier
 * per-template emit already created is a no-op here.
 *
 * No public/LAN domain or no subdomain-typed variables → nothing to
 * route. A pure-LAN install with no subdomains is a valid no-op.
 */
export async function ensureProxyHosts(
  jobId: string,
  variables: StackVariable[],
  node: string | undefined,
): Promise<void> {
  const { domain, hosts } = buildProxyHosts(variables);
  if (!domain || hosts.length === 0) return;
  try {
    const res = await apiFetch('/api/system/nginx/proxy-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts, publicDomain: domain, node }),
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      const msg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      await log(jobId, `⚠️ Could not create per-service proxy hosts: ${msg}. Settings → Self-Diagnose → Reprovision will retry.`);
      return;
    }
    const created = Array.isArray(data.created) ? (data.created as string[]) : [];
    const failed = Array.isArray(data.failed) ? (data.failed as Array<{ domain?: string }>) : [];
    await log(jobId, `✅ Per-service proxy hosts ensured for ${hosts.length} service domain(s)${created.length ? ` (${created.join(', ')})` : ''}.`);
    if (failed.length > 0) {
      const names = failed.map(f => f.domain ?? '?').join(', ');
      await log(jobId, `⚠️ Some proxy hosts could not be created: ${names}. Self-diagnose → Reprovision will retry.`);
    }
  } catch (e) {
    await log(jobId, `⚠️ Per-service proxy-host creation failed: ${e instanceof Error ? e.message : String(e)}. Settings → Self-Diagnose → Reprovision will retry.`);
  }
}

/**
 *  Last-mile guard for Authelia OIDC clients (#989). Mirrors `ensureProxyHosts`:
 *  the capability bus already emits `feature.installed` per template and the
 *  Authelia handler registers that one template's OIDC client(s) — but the
 *  per-template path is fragile (auth pod is restarting between writes, or
 *  the emit happens before `auth` is reachable). When a single handler
 *  invocation under-produces, the operator hits "client not registered" at
 *  SSO time and ends up editing configuration.yml by hand.
 *
 *  This pass walks every template in this install whose variables.json
 *  declares an `oidcClient` and sends them through `/api/system/authelia/oidc-clients`
 *  in ONE batched call — the endpoint is idempotent (skips existing
 *  client_ids), so any client a per-template emit already created is a
 *  no-op here. Anything missed gets added in this single write + restart.
 *  The install no longer depends on every per-template emit landing.
 */
export async function ensureOidcClients(
  jobId: string,
  templateNames: string[],
  variables: StackVariable[],
): Promise<void> {
  const variableMap = variables.reduce<Record<string, string>>((acc, v) => {
    acc[v.name] = v.value;
    return acc;
  }, {});
  if (!variableMap.PUBLIC_DOMAIN) return; // LAN-only install — no OIDC

  const templatesWithOidc: { name: string }[] = [];
  for (const name of templateNames) {
    try {
      const meta = await getTemplateVariables(name);
      if (!meta) continue;
      const hasOidc = Object.values(meta).some(
        v => v.type === 'subdomain' && v.oidcClient?.client_id,
      );
      if (hasOidc) templatesWithOidc.push({ name });
    } catch {
      // template not on disk / unparseable — skip it. The per-template
      // emit would have noticed the same problem and surfaced a diagnose
      // finding.
    }
  }
  if (templatesWithOidc.length === 0) return;

  try {
    const res = await apiFetch('/api/system/authelia/oidc-clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templates: templatesWithOidc, variables: variableMap }),
    });
    if (res.status === 404) {
      // Authelia not deployed (e.g. feature-only install on a host where
      // `auth` was never selected). Soft warning — matches the per-template
      // handler's 404 behaviour.
      await log(jobId, `(note) Authelia not deployed — skipped OIDC client reconciliation for ${templatesWithOidc.map(t => t.name).join(', ')}.`);
      return;
    }
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      const msg = typeof data.error === 'string' ? data.error : `HTTP ${res.status}`;
      await log(jobId, `⚠️ Could not reconcile Authelia OIDC clients: ${msg}. Settings → Self-Diagnose → Reprovision will retry.`);
      return;
    }
    const added = Array.isArray(data.added) ? (data.added as string[]) : [];
    const skipped = Array.isArray(data.skipped) ? (data.skipped as string[]) : [];
    if (added.length > 0) {
      await log(jobId, `✅ Registered ${added.length} Authelia OIDC client(s): ${added.join(', ')}.`);
    } else if (skipped.length > 0) {
      await log(jobId, `✅ All ${skipped.length} Authelia OIDC client(s) already registered.`);
    }
  } catch (e) {
    await log(jobId, `⚠️ Authelia OIDC reconciliation failed: ${e instanceof Error ? e.message : String(e)}. Settings → Self-Diagnose → Reprovision will retry.`);
  }
}
