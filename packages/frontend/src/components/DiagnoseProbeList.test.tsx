import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import DiagnoseProbeList, { type DiagnoseProbe } from './DiagnoseProbeList';

function probe(over: Partial<DiagnoseProbe> = {}): DiagnoseProbe {
  return {
    id: 'p1',
    label: 'DNS resolves',
    status: 'fail',
    detail: 'admin.home.arpa did not resolve',
    actions: [],
    group: 'dns-network',
    ...over,
  };
}

describe('DiagnoseProbeList — design-system tokens (#2100)', () => {
  it('renders probe rows on status tokens, no raw color literals for surfaces', () => {
    const { container } = render(
      <DiagnoseProbeList probes={[probe(), probe({ id: 'p2', status: 'ok', label: 'TLS valid', group: 'tls' })]} node="Local" />,
    );
    // Probe labels are present (functional render intact).
    expect(screen.getByText('DNS resolves')).toBeTruthy();
    expect(screen.getByText('TLS valid')).toBeTruthy();

    const html = container.innerHTML;
    // Status/severity styling uses semantic status tokens.
    expect(html).toMatch(/text-status-(ok|warn|fail|info)/);
    expect(html).toMatch(/bg-status-(ok|warn|fail|info)\/10/);
    // No raw severity color literals remaining for surfaces/borders.
    expect(html).not.toMatch(/(bg|text|border)-(emerald|amber|red|rose|blue|violet|green)-\d/);
  });

  it('renders action buttons on the Button primitive (data-variant), destructive => danger', () => {
    render(
      <DiagnoseProbeList
        node="Local"
        probes={[
          probe({
            actions: [
              { id: 'fix', label: 'Fix it', description: 'do the thing' },
              { id: 'wipe', label: 'Wipe', description: 'destructive', destructive: true },
            ],
          }),
        ]}
      />,
    );
    const fix = screen.getByRole('button', { name: /Fix it/ });
    const wipe = screen.getByRole('button', { name: /Wipe/ });
    expect(fix.getAttribute('data-variant')).toBe('primary');
    expect(wipe.getAttribute('data-variant')).toBe('danger');
    // No raw violet/red button literals.
    expect(fix.className).not.toMatch(/violet-\d|red-\d/);
  });

  // #2615 — the two backup mechanisms must reach the operator as two rows with
  // two verdicts. A single "backups: ok" row is what let a healthy nightly
  // config push stand in for a content backup that had never been configured.
  it('renders content backup and config backup as two separate rows under Storage & backups', () => {
    render(
      <DiagnoseProbeList
        node="Local"
        probes={[
          probe({
            id: 'content_backup',
            label: 'Content backup (Backup Sync)',
            status: 'warn',
            group: 'storage-backups',
            detail: 'Content backup (Backup Sync) has never been configured — there is no source directory and no target.',
          }),
          probe({
            id: 'config_backup',
            label: 'Config backup (last nightly run)',
            status: 'ok',
            group: 'storage-backups',
            detail: 'The nightly config backup ran 6 hours ago: 11/11 services written to the NAS. Covers per-service configuration only — the bulk content under /mnt/data is excluded by design.',
          }),
        ]}
      />,
    );
    expect(screen.getByText('Storage & backups')).toBeTruthy();
    // Two distinct, separately-labelled rows — not one collapsed "backups" row.
    expect(screen.getByText('Content backup (Backup Sync)')).toBeTruthy();
    expect(screen.getByText('Config backup (last nightly run)')).toBeTruthy();
    // The never-configured state is legible as text, not as an exception.
    expect(screen.getByText(/has never been configured/)).toBeTruthy();
    // …and the green row states its own limit right where it is read.
    expect(screen.getByText(/excluded by design/)).toBeTruthy();
  });

  it('compact mode hides ok probes (behavior preserved)', () => {
    render(
      <DiagnoseProbeList
        node="Local"
        compact
        probes={[probe({ id: 'ok1', status: 'ok', label: 'All good', group: 'tls' }), probe()]}
      />,
    );
    expect(screen.queryByText('All good')).toBeNull();
    expect(screen.getByText('DNS resolves')).toBeTruthy();
  });
});
