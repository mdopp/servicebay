/**
 * `nginx_config_valid` probe (#1678) — runs `nginx -t` inside the NPM
 * (reverse-proxy) container on the node and fails when the *on-disk*
 * nginx config is invalid, even though nginx may still be serving fine
 * on an older, already-loaded config.
 *
 * This is the early-warning half of the #1677 defense: a single
 * malformed proxy-host config (e.g. ollama's empty Authelia port
 * `proxy_pass http://127.0.0.1:/api/authz/...` → `nginx: [emerg]
 * invalid port`) is tolerated by the *running* config but CRASHES the
 * entire proxy on the next reload/reboot. `nginx -t` validates the
 * on-disk config and surfaces the drift while nginx is still up — so a
 * silent landmine becomes a red check + alert now, not a full-proxy
 * outage on the next boot.
 *
 * The check parses the `[emerg]` line and the offending
 * `proxy_host/<id>.conf`, and (cheaply, best-effort) maps that numeric
 * id back to the host's primary domain via the NPM API.
 */

import { registerProbe } from './registry';
import { findNpmAdminUrl, getNpmToken } from './npmAdmin';

type Payload = { status: 'ok' | 'fail' | 'info'; detail: string; hint?: string; hostId?: number; domain?: string };

const encode = (payload: Payload) => ({
  status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const),
  payload,
});

export interface NginxTestParse {
  ok: boolean;
  /** The `nginx: [emerg] ...` line, when one is present. */
  emergLine?: string;
  /** Numeric proxy_host id parsed from `.../proxy_host/<id>.conf`. */
  hostId?: number;
}

/**
 * Parse the combined stdout+stderr of `nginx -t` plus its exit code.
 * Exit 0 → valid. Non-zero → invalid; pull out the first `[emerg]`
 * line and, when the offending file is a `proxy_host/<id>.conf`, the
 * numeric host id.
 *
 * Pure + exported so the fail/parse logic is unit-tested without a node.
 */
export function parseNginxTestOutput(output: string, exitCode: number): NginxTestParse {
  if (exitCode === 0) return { ok: true };
  const text = output ?? '';
  // Match the whole line containing `[emerg]`. `nginx -t` emits some errors
  // with a `nginx: [emerg]` prefix (e.g. invalid port) and others with a
  // timestamp prefix (`2026/07/14 15:21 [emerg] duplicate location …`). The
  // old `nginx:`-only pattern missed the timestamp form, reddening the check
  // with no detail line.
  const emergMatch = text.match(/^.*\[emerg\].*$/m);
  const emergLine = emergMatch ? emergMatch[0].trim() : undefined;
  const hostMatch = text.match(/proxy_host\/(\d+)\.conf/);
  const hostId = hostMatch ? Number(hostMatch[1]) : undefined;
  return { ok: false, emergLine, hostId };
}

/** Best-effort id→domain map via the NPM API. Returns the host's primary
 *  domain for the parsed proxy_host id, or undefined when it can't resolve
 *  (NPM unreachable / id not found) — the check still reds either way. */
async function resolveHostDomain(node: string, hostId: number): Promise<string | undefined> {
  try {
    const admin = await findNpmAdminUrl(node);
    if (admin.kind !== 'url') return undefined;
    const token = await getNpmToken(admin.url);
    if (!token) return undefined;
    const res = await fetch(`${admin.url}/api/nginx/proxy-hosts`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return undefined;
    const hosts = (await res.json()) as Array<{ id?: number; domain_names?: string[] }>;
    if (!Array.isArray(hosts)) return undefined;
    const host = hosts.find(h => h.id === hostId);
    return host?.domain_names?.[0];
  } catch {
    return undefined;
  }
}

registerProbe({
  type: 'nginx_config_valid',
  async run(check, ctx) {
    const node = check.nodeName ?? 'Local';
    try {
      // Locate the running NPM container (same discovery the rekey path
      // uses — match the proxy-manager image, take the first name).
      const find = await ctx.executor.exec(
        `podman ps --format '{{.Names}} {{.Image}}' | awk '/proxy-manager/{print $1; exit}'`,
        { timeoutMs: 15_000 },
      );
      const container = (find.stdout || '').trim().split(/\s+/)[0];
      if (!container) {
        return encode({ status: 'info', detail: 'Nginx Proxy Manager not running on this node — nothing to validate.' });
      }

      let output = '';
      let exitCode = 0;
      try {
        // execArgv quotes each arg (shellQuoteAll) — `container` comes from
        // `podman ps` output but is never shell-interpolated.
        const res = await ctx.executor.execArgv(['podman', 'exec', container, 'nginx', '-t'], { timeoutMs: 20_000 });
        // `nginx -t` writes its "syntax is ok" banner to stderr even on success.
        output = `${res.stdout}\n${res.stderr}`;
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
        exitCode = typeof err.code === 'number' ? err.code : 1;
        output = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`;
      }

      const parsed = parseNginxTestOutput(output, exitCode);
      if (parsed.ok) {
        return encode({ status: 'ok', detail: 'On-disk nginx config is valid (`nginx -t` passed).' });
      }

      const domain = parsed.hostId !== undefined ? await resolveHostDomain(node, parsed.hostId) : undefined;
      const hostLabel = parsed.hostId !== undefined
        ? `proxy_host/${parsed.hostId}.conf${domain ? ` (${domain})` : ''}`
        : 'an unidentified config file';
      const emerg = parsed.emergLine || 'nginx reported a config error (no [emerg] line captured).';

      return encode({
        status: 'fail',
        detail: `On-disk nginx config is INVALID — it will brick the proxy on the next reload/reboot. nginx is still serving on the old config for now. Offending file: ${hostLabel}. ${emerg}`,
        hint: 'Fix or remove the bad proxy host in Nginx Proxy Manager before the next reboot. A common cause is a forward-auth `proxy_pass` with a missing port (e.g. `http://127.0.0.1:/...`). Do NOT reboot until `nginx -t` passes.',
        hostId: parsed.hostId,
        domain,
      });
    } catch (e) {
      return { status: 'fail', message: `nginx_config_valid error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
