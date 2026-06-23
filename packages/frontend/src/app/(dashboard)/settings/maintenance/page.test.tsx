/**
 * Maintenance settings page — design-system migration (#2100 cluster 2). The
 * launch card surface moved to token Card chrome (border-border/bg-surface);
 * asserts no raw colour literals remain and the launcher still links out.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MaintenanceSettingsPage from './page';

describe('MaintenanceSettingsPage (#2100 settings migration)', () => {
  it('renders the disk-import launcher with no raw colour literals', () => {
    const { container } = render(<MaintenanceSettingsPage />);
    const link = screen.getByTestId('maintenance-launch-disk-import');
    expect(link.getAttribute('href')).toBe('/disk-import');

    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
    // Token surface in use.
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
  });
});
