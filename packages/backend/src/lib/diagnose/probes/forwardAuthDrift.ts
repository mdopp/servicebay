/**
 * `forward_auth_drift` probe (#2932) — a host that *describes itself* as
 * SSO-gated but whose LIVE nginx config no longer gates it.
 *
 * The hole this closes is a reporting hole, not only a rendering one. An
 * `authSkipPaths: ["/"]` entry (or a hand-edit, or a partial NPM
 * reconcile) produces a perfectly valid conf: NPM keeps `nginx_online`
 * true, `dangling_proxy` sees a live upstream, `get_proxy_routes` and the
 * UI still show the host as forward-auth gated — and every request walks
 * straight past Authelia. Nothing was red.
 *
 * Three drift shapes are read off the live `advanced_config`, all of them
 * self-contradictions that need no second source of truth:
 *
 * - `auth-request-missing` — the forward-auth machinery is still there
 *   (the internal `/api/authz/auth-request` upstream, the `auth_request_set
 *   $user $upstream_http_remote_user` captures) but the server-level
 *   `auth_request /authelia;` that actually gates the host is gone. The
 *   Remote-* headers are still forwarded, so the upstream believes it is
 *   behind SSO.
 * - `host-wide-bypass` — the host IS gated, and also carries an
 *   `auth_request off` location whose prefix covers every path. The gate is
 *   present and inert.
 * - `unparseable` — the config's braces do not balance, so a directive has
 *   escaped its block and nginx is reading something other than what the
 *   config appears to say.
 *
 * The classifier is pure and takes the host list as data; the network read
 * lives in {@link checkForwardAuthDrift}. Unreadable NPM degrades to
 * `info`, never to a green `ok` — this probe exists precisely because a
 * false green is the failure mode.
 */

import { findNpmAdmin, getNpmToken } from '@/lib/npm/client';
import { listProxyHosts, type NpmProxyHost } from '@/lib/npm/proxyHosts';
import {
  analyzeForwardAuthConfig,
  hostWideBypasses,
} from '@/lib/stackInstall/authSkipPaths';
import type { ProbeItem } from '../actions';

/** A live host reduced to what the classifier needs. */
export interface ForwardAuthHostConfig {
  domain: string;
  advancedConfig: string;
}

type ForwardAuthDriftKind = 'auth-request-missing' | 'host-wide-bypass' | 'unparseable';

export interface ForwardAuthDriftItem {
  domain: string;
  kind: ForwardAuthDriftKind;
  /** Operator-facing sentence: what is wrong and what it means. */
  detail: string;
}

export interface ForwardAuthDriftResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

/**
 * Classify every host that claims forward-auth. A host with no
 * forward-auth machinery at all is not our business — it never claimed to
 * be gated, so it cannot have drifted.
 */
export function classifyForwardAuthDrift(hosts: ForwardAuthHostConfig[]): ForwardAuthDriftItem[] {
  const out: ForwardAuthDriftItem[] = [];
  for (const host of hosts) {
    const analysis = analyzeForwardAuthConfig(host.advancedConfig);
    if (!analysis.forwardAuthMachinery && !analysis.serverAuthRequest) continue;
    if (!analysis.balanced) {
      out.push({
        domain: host.domain,
        kind: 'unparseable',
        detail: 'The nginx config for this host does not close its blocks — a directive has escaped its location, so nginx is not reading what the config appears to say. Treat the host as ungated until it is re-rendered.',
      });
      continue;
    }
    if (!analysis.serverAuthRequest) {
      out.push({
        domain: host.domain,
        kind: 'auth-request-missing',
        detail: 'This host still carries the Authelia forward-auth wiring (the internal auth-request upstream and the Remote-* headers) but no longer carries the `auth_request /authelia;` that enforces it. Every request reaches the app unauthenticated, and the app still sees Remote-* headers as if SSO had run.',
      });
      continue;
    }
    const bypasses = hostWideBypasses(analysis);
    if (bypasses.length > 0) {
      out.push({
        domain: host.domain,
        kind: 'host-wide-bypass',
        detail: `This host is forward-auth gated and also carries an \`auth_request off\` location for "${bypasses.join('", "')}", which covers every path. The gate is present but inert — the host reads as SSO-protected everywhere and protects nothing.`,
      });
    }
  }
  return out;
}

/** Fetch NPM's proxy host list, or null on any failure. */
async function fetchHosts(adminUrl: string, token: string): Promise<NpmProxyHost[] | null> {
  try {
    const res = await listProxyHosts(adminUrl, token, { timeoutMs: 8000 });
    if (!res.ok) return null;
    return Array.isArray(res.data) ? res.data : null;
  } catch {
    return null;
  }
}

/** Read the live hosts and rate their forward-auth gating. */
export async function checkForwardAuthDrift(node: string): Promise<ForwardAuthDriftResult> {
  // requireActive: false — the twin's `active` flag lies for the kube nginx
  // pod (#496); the API read below is the real liveness check.
  const adminUrl = (await findNpmAdmin({ node, requireActive: false }))?.apiUrl;
  if (!adminUrl) {
    return { status: 'info', detail: 'Nginx Proxy Manager is not deployed on this node.' };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      status: 'info',
      detail: 'Could not authenticate against NPM to read the per-host SSO gating. If npm_data_stale is also warning, fix that first.',
    };
  }
  const hosts = await fetchHosts(adminUrl, token);
  if (hosts === null) {
    return { status: 'info', detail: 'Could not read the NPM proxy host list, so forward-auth gating is unverified.' };
  }
  const configs: ForwardAuthHostConfig[] = hosts.map(h => ({
    domain: h.domain_names?.[0] ?? `host ${h.id}`,
    advancedConfig: h.advanced_config ?? '',
  }));
  const gated = configs.filter(c => {
    const a = analyzeForwardAuthConfig(c.advancedConfig);
    return a.forwardAuthMachinery || a.serverAuthRequest;
  }).length;
  const drifted = classifyForwardAuthDrift(configs);
  if (drifted.length === 0) {
    return {
      status: 'ok',
      detail: gated === 0
        ? 'No host is behind Authelia forward-auth, so there is no SSO gating to drift.'
        : `${gated} forward-auth host${gated === 1 ? '' : 's'} still gate every path outside their declared skip prefixes.`,
    };
  }
  const items: ProbeItem[] = drifted.map(d => ({
    id: d.domain,
    label: d.domain,
    detail: d.detail,
    status: 'fail',
    // No self-heal button: re-rendering a host whose gate an operator may
    // have edited on purpose is not a decision this probe gets to make.
    // The row's job is to stop the false green.
    actionIds: [],
  }));
  return {
    status: 'fail',
    detail: `${drifted.length} host${drifted.length === 1 ? '' : 's'} of ${gated} present as SSO-gated but are not: the login wall is missing or switched off for every path, while NPM, the route list and the UI all stay green.`,
    hint: 'Re-create the route (or fix its advanced_config) so `auth_request /authelia;` is back at server level and no `auth_request off` location covers "/". A skip list must name specific prefixes.',
    items,
  };
}
