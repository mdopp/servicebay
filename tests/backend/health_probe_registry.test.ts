/**
 * Probe registry + dispatcher sanity tests (#592).
 *
 * Per-probe behavioural tests already exist for the diagnose-side
 * mirrors (src/lib/diagnose/probes/*.test.ts) and would be heavy to
 * duplicate end-to-end here. What this file pins is the structural
 * contract: every legacy check type still has a probe registered and
 * the dispatcher falls through cleanly for unknown types.
 */

import { describe, it, expect } from 'vitest';
import { registeredProbeTypes, getProbe } from '@/lib/health/probes/registry';
import '@/lib/health/probes';

describe('Probe registry (#592)', () => {
  // `dns_routing` is intentionally absent (#1564): the per-domain
  // dns_routing rows were collapsed into the canonical `domain` check,
  // which now runs the DoH DNS-routing logic itself. No standalone
  // `dns_routing` probe registers any more.
  const EXPECTED_TYPES = [
    'http', 'ping', 'script', 'podman', 'service', 'systemd', 'node', 'agent',
    'fritzbox', 'backup', 'domain', 'letsdebug', 'lan_ip_drift', 'npm_auth',
    'cert_expiry', 'cert_request_failure',
  ];

  it('every legacy check type has a probe registered', () => {
    const registered = new Set(registeredProbeTypes());
    for (const t of EXPECTED_TYPES) {
      expect(registered.has(t as never), `missing probe: ${t}`).toBe(true);
    }
  });

  it('getProbe returns undefined for unknown types', () => {
    expect(getProbe('definitely_not_a_check_type' as never)).toBeUndefined();
  });
});
