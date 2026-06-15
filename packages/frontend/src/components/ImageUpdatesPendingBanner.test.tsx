import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ImageUpdatesPendingBanner from './ImageUpdatesPendingBanner';
import type { ServiceImageUpdate } from '@/hooks/useImageUpdates';

const update = (service: string, image: string): ServiceImageUpdate => ({
  service,
  image,
  runningDigest: 'sha256:old',
  registryDigest: 'sha256:new',
  updateAvailable: true,
});

describe('ImageUpdatesPendingBanner', () => {
  it('renders nothing when no updates are pending', () => {
    const { container } = render(<ImageUpdatesPendingBanner updates={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists every affected service with its image', () => {
    render(
      <ImageUpdatesPendingBanner
        updates={[update('immich', 'ghcr.io/immich/server:latest'), update('vaultwarden', 'docker.io/vaultwarden/server:1.30')]}
      />,
    );
    expect(screen.getByText(/2 service image updates available/i)).not.toBeNull();
    expect(screen.getByText('immich')).not.toBeNull();
    expect(screen.getByText('ghcr.io/immich/server:latest')).not.toBeNull();
    expect(screen.getByText('vaultwarden')).not.toBeNull();
  });

  it('uses the singular form for a single update', () => {
    render(<ImageUpdatesPendingBanner updates={[update('immich', 'ghcr.io/immich/server:latest')]} />);
    expect(screen.getByText(/1 service image update available/i)).not.toBeNull();
  });
});
