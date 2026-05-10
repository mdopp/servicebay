import { describe, it, expect } from 'vitest';
import { injectServiceDirectives } from './quadletDirectives';

describe('injectServiceDirectives', () => {
  it('injects [Service] directives into an existing [Service] section', () => {
    const input = '[Kube]\nYaml=foo.yml\n\n[Install]\nWantedBy=default.target\n[Service]\n';
    const out = injectServiceDirectives(input);
    expect(out).toMatch(/\[Service\]\s*\n[^[]*Restart=on-failure/);
    expect(out).toContain('TimeoutStartSec=600');
  });

  it('places StartLimitIntervalSec in [Unit], not [Service]', () => {
    const input = '[Kube]\nYaml=foo.yml\n\n[Install]\nWantedBy=default.target\n';
    const out = injectServiceDirectives(input);

    // StartLimitIntervalSec must be under [Unit] for systemd to honor it.
    // Prior bug: it was emitted under [Service] and silently ignored.
    const unitIdx = out.indexOf('[Unit]');
    const serviceIdx = out.indexOf('[Service]');
    const limitIdx = out.indexOf('StartLimitIntervalSec=0');
    expect(unitIdx).toBeGreaterThanOrEqual(0);
    expect(limitIdx).toBeGreaterThan(unitIdx);
    if (serviceIdx >= 0 && serviceIdx > unitIdx) {
      // [Service] follows [Unit] — limit must appear before [Service]
      expect(limitIdx).toBeLessThan(serviceIdx);
    }
  });

  it('is idempotent — does not duplicate keys already set by the source', () => {
    const input =
      '[Kube]\nYaml=foo.yml\n[Service]\nRestart=always\nTimeoutStartSec=120\n[Unit]\nStartLimitIntervalSec=42\n';
    const out = injectServiceDirectives(input);
    expect(out.match(/^Restart=/gm)?.length).toBe(1);
    expect(out.match(/^TimeoutStartSec=/gm)?.length).toBe(1);
    expect(out.match(/^StartLimitIntervalSec=/gm)?.length).toBe(1);
    expect(out).toContain('Restart=always');
    expect(out).toContain('TimeoutStartSec=120');
    expect(out).toContain('StartLimitIntervalSec=42');
  });

  it('appends [Service] and [Unit] sections when missing', () => {
    const input = '[Kube]\nYaml=foo.yml\n';
    const out = injectServiceDirectives(input);
    expect(out).toContain('[Service]');
    expect(out).toContain('[Unit]');
    expect(out).toContain('StartLimitIntervalSec=0');
    expect(out).toContain('Restart=on-failure');
  });
});
