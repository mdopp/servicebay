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
