import { describe, it, expect } from 'vitest';
import { groupForProbe, type ProbeGroup } from '@/lib/diagnose/runDiagnose';

/**
 * #1534 — every diagnose probe maps to exactly one problem-domain card,
 * and the info-only probes land in the collapsed `system-info` group.
 * Pins the curated grouping so a probe doesn't silently drift between
 * cards (or vanish) when the suite is edited.
 */
describe('groupForProbe (#1534 problem-domain grouping)', () => {
  it('folds the service/runtime cluster into one "services" card', () => {
    for (const id of ['agent', 'podman', 'pods', 'failed_units', 'crash_loop', 'post_deploy_failed']) {
      expect(groupForProbe(id)).toBe<ProbeGroup>('services');
    }
  });

  it('maps the consolidated problem probes to their domain card', () => {
    const cases: Record<string, ProbeGroup> = {
      dangling_proxy: 'reverse-proxy',
      npm_data_stale: 'proxy-admin',
      domain_unreachable: 'domains',
      lan_ip_changed_since_install: 'dns-network',
      router_dns_not_pointing: 'dns-network',
      adguard_rewrites_missing: 'dns-network',
      cert_expiry: 'tls',
      sso_verify: 'sso',
      disk: 'storage-backups',
      nas_backup_reachable: 'storage-backups',
    };
    for (const [id, group] of Object.entries(cases)) {
      expect(groupForProbe(id)).toBe(group);
    }
  });

  it('demotes the info-only probes to the collapsed system-info group', () => {
    for (const id of ['serial', 'ports', 'first_boot', 'health_checks']) {
      expect(groupForProbe(id)).toBe<ProbeGroup>('system-info');
    }
  });

  it('defaults an unmapped probe to "other" rather than dropping it', () => {
    expect(groupForProbe('some_future_probe')).toBe<ProbeGroup>('other');
  });
});
