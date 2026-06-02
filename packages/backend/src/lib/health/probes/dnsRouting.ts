/**
 * `dns_routing` probe — resolves the target domain via Cloudflare DoH
 * and compares the A record to twin.gateway.publicIp. Replaces the
 * continuous letsdebug sweep for "does my domain still point at me?".
 */

import { registerProbe } from './registry';

registerProbe({
  type: 'dns_routing',
  async run(check) {
    const domain = check.target;
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

    const payload: { expected: string | null; resolved: string[]; matched: boolean } = {
      expected: haveExpected ? expectedIp : null,
      resolved: answers,
      matched: haveExpected && answers.includes(expectedIp),
    };

    if (!haveExpected) {
      return { status: 'ok', payload };
    }
    if (answers.length === 0) {
      return { status: 'fail', payload };
    }
    return {
      status: payload.matched ? 'ok' : 'fail',
      payload,
    };
  },
});
