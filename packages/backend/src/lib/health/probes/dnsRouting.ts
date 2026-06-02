/**
 * DoH-based DNS-routing logic — resolves a domain via Cloudflare DoH
 * and compares the A record to twin.gateway.publicIp ("does my domain
 * still point at me?").
 *
 * As of #1564 this no longer registers its own `dns_routing` health
 * check type. The per-domain `dns_routing:<domain>` rows were collapsed
 * into the canonical `domain:<domain>` check (one row per domain that
 * subsumes both NPM-routing and DNS-routing). The reusable
 * `resolveDnsRouting` helper below is called by the `domain` probe for
 * public domains; its payload rides the `domain` check's result.
 */

/** Combined DNS-routing outcome attached to a `domain` check payload. */
export interface DnsRoutingPayload {
  expected: string | null;
  resolved: string[];
  matched: boolean;
}

export interface DnsRoutingOutcome {
  status: 'ok' | 'fail';
  payload?: DnsRoutingPayload;
  /** Transport-level error (DoH unreachable / non-200) — no payload. */
  message?: string;
}

/**
 * Resolve `domain` via Cloudflare DoH and compare the A record(s) to the
 * gateway's known public IP. `ok` when the public IP isn't known yet
 * (nothing to compare), when the record matches, otherwise `fail`. A
 * transport failure returns `{ status:'fail', message }` with no payload.
 */
export async function resolveDnsRouting(domain: string): Promise<DnsRoutingOutcome> {
  if (!domain) return { status: 'fail', message: 'dns_routing check has no target domain.' };

  const { getGateway } = await import('../../store/repository');
  const expectedIp = getGateway()?.publicIp ?? '';
  const haveExpected = !!expectedIp && expectedIp !== '0.0.0.0';

  let answers: string[];
  try {
    const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`;
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { status: 'fail', message: `DoH lookup HTTP ${res.status}` };
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    answers = (body.Answer ?? []).filter(a => a.type === 1).map(a => a.data);
  } catch (e) {
    return { status: 'fail', message: `DoH lookup failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const payload: DnsRoutingPayload = {
    expected: haveExpected ? expectedIp : null,
    resolved: answers,
    matched: haveExpected && answers.includes(expectedIp),
  };

  if (!haveExpected) return { status: 'ok', payload };
  if (answers.length === 0) return { status: 'fail', payload };
  return { status: payload.matched ? 'ok' : 'fail', payload };
}
