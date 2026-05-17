/**
 * Probe registry + dispatcher sanity tests (#592).
 *
 * Per-probe behavioural tests already exist for the diagnose-side
 * mirrors (src/lib/diagnose/probes/*.test.ts) and would be heavy to
 * duplicate end-to-end here. What this file pins is the structural
 * contract: every legacy check type still has a probe registered,
 * the dispatcher falls through cleanly for unknown types, and the
 * existing message-prefix re-exports still resolve from `runner.ts`.
 */

import { describe, it, expect } from 'vitest';
import { registeredProbeTypes, getProbe } from '../../src/lib/health/probes/registry';
import '../../src/lib/health/probes';
import {
  LETSDEBUG_MESSAGE_PREFIX,
  LAN_IP_DRIFT_MESSAGE_PREFIX,
  NPM_AUTH_MESSAGE_PREFIX,
  CERT_EXPIRY_MESSAGE_PREFIX,
  CERT_REQUEST_FAILURE_MESSAGE_PREFIX,
  DNS_ROUTING_MESSAGE_PREFIX,
} from '../../src/lib/health/runner';

describe('Probe registry (#592)', () => {
  const EXPECTED_TYPES = [
    'http', 'ping', 'script', 'podman', 'service', 'systemd', 'node', 'agent',
    'fritzbox', 'backup', 'domain', 'letsdebug', 'lan_ip_drift', 'npm_auth',
    'cert_expiry', 'cert_request_failure', 'dns_routing',
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

  it('message-prefix constants still re-export from runner.ts (back-compat for diagnose readers)', () => {
    expect(LETSDEBUG_MESSAGE_PREFIX).toBe('letsdebug:');
    expect(LAN_IP_DRIFT_MESSAGE_PREFIX).toBe('lan_ip_drift:');
    expect(NPM_AUTH_MESSAGE_PREFIX).toBe('npm_auth:');
    expect(CERT_EXPIRY_MESSAGE_PREFIX).toBe('cert_expiry:');
    expect(CERT_REQUEST_FAILURE_MESSAGE_PREFIX).toBe('cert_request_failure:');
    expect(DNS_ROUTING_MESSAGE_PREFIX).toBe('dns_routing:');
  });
});
