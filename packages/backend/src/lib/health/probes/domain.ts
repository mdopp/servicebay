/**
 * `domain` probe — talks to local NPM with a `Host:` header rather
 * than resolving the domain name, so RFC 8375 `.home.arpa` zones work
 * from inside ServiceBay's container even when its own resolver
 * doesn't know about them. See runner.ts for the full rationale
 * (preserved here in a shorter form).
 *
 * No SSRF guard: hitting our own LAN IP is the point.
 */

import { registerProbe } from './registry';
import { getConfig } from '../../config';

async function checkNpmRouting(lanIp: string, target: string, expectedScheme?: string) {
  const url = `http://${lanIp}:80/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Host: target },
    });

    if (res.status === 404 || res.status === 503) {
      const body = await res.text().catch(() => '');
      if (body.includes('Congratulations') || body.includes('nginx-proxy-manager')) {
        throw new Error(`Proxy host for ${target} not configured in NPM`);
      }
    }

    if (expectedScheme === 'https' && (res.status === 301 || res.status === 302)) {
      const loc = res.headers.get('location') || '';
      if (loc.startsWith('https://')) return { message: `routed via NPM, ssl_forced redirect to ${loc}` };
      return { message: `routed via NPM, redirect ${res.status} to ${loc || '(empty)'}` };
    }

    if (res.status >= 200 && res.status < 400) {
      return { message: `routed via NPM, HTTP ${res.status}` };
    }
    throw new Error(`NPM returned HTTP ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

registerProbe({
  type: 'domain',
  async run(check) {
    const cfg = check.domainConfig;
    if (!cfg) throw new Error('domainConfig missing');
    const config = await getConfig();
    const lanIp = config.reverseProxy?.lanIp;
    if (!lanIp) throw new Error('reverseProxy.lanIp not configured — cannot probe NPM');
    return checkNpmRouting(lanIp, check.target, cfg.expectedScheme);
  },
});
