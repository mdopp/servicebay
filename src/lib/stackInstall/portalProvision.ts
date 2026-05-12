/**
 * Drives `/api/system/portal/provision` with retries, narrating progress
 * to a caller-supplied logger. The endpoint already calls
 * `provisionPortalRouting()` which is idempotent — we just give it more
 * chances than the implicit fire-and-forget triggers (AdGuard's
 * post-deploy hook + the 60s-post-boot timer in server.ts).
 *
 * Why this exists: on a fresh install, AdGuard's post-deploy POSTs
 * credentials the moment the container reports healthy, which then fires
 * `provisionPortalRouting()` in the background. That one shot can land
 * while AdGuard's REST API is still finishing its own bootstrap — the
 * call returns non-2xx, the provisioner records "failed", and nothing
 * retries until the operator notices missing rewrites and clicks
 * Reprovision in diagnose. By the time the install loop reaches this
 * helper, every other service is deployed and AdGuard has had time to
 * warm up; a short retry loop here turns the lossy fire-and-forget into
 * a guaranteed-present rewrite list.
 *
 * Used to live inside `useStackInstall.ts` (client-only). Moved here
 * when the install loop became server-side so both contexts can share
 * the implementation.
 *
 * Returns true if the endpoint reported `ok` on any attempt; false if
 * every attempt failed (the caller logs a fallback suggestion in that
 * case).
 */

const PORTAL_PROVISION_ATTEMPTS = 4;
/** Backoff between portal-provision attempts (ms). Total wall-clock cost
 *  if every attempt fails: ~18s. Hits the cold-start window for AdGuard's
 *  `/control/rewrite/*` endpoints, which can lag `/control/status` by a
 *  few seconds on first boot. */
const PORTAL_PROVISION_BACKOFF_MS = [0, 3000, 6000, 9000];

function apiFetch(p: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== 'undefined') return fetch(p, init);
  const port = process.env.PORT || '3000';
  return fetch(`http://127.0.0.1:${port}${p}`, init);
}

export async function provisionPortalWithRetries(onLog: (msg: string) => void): Promise<boolean> {
  for (let attempt = 1; attempt <= PORTAL_PROVISION_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, PORTAL_PROVISION_BACKOFF_MS[attempt - 1]));
    }
    try {
      const res = await apiFetch('/api/system/portal/provision', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; detail?: string }
        | null;
      if (data?.ok) {
        onLog(`✅ Portal routing: ${data.detail ?? 'provisioned'}`);
        return true;
      }
      const reason = data?.detail ?? `HTTP ${res.status}`;
      const tag = attempt < PORTAL_PROVISION_ATTEMPTS ? '⏳' : '⚠️';
      onLog(`${tag} Portal routing attempt ${attempt}/${PORTAL_PROVISION_ATTEMPTS}: ${reason}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const tag = attempt < PORTAL_PROVISION_ATTEMPTS ? '⏳' : '⚠️';
      onLog(`${tag} Portal routing attempt ${attempt}/${PORTAL_PROVISION_ATTEMPTS}: ${reason}`);
    }
  }
  onLog('⚠️ Portal routing did not fully provision after retries. Open Settings → Self-Diagnose → Reprovision if rewrites are missing.');
  return false;
}
