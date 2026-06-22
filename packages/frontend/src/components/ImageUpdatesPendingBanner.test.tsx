import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('renders no action button when onUpdate is not provided (informational only)', () => {
    render(<ImageUpdatesPendingBanner updates={[update('immich', 'ghcr.io/immich/server:latest')]} />);
    expect(screen.queryByRole('button', { name: /update now/i })).toBeNull();
  });

  it('triggers onUpdate with every listed update when the "Update now" button is clicked', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const updates = [update('immich', 'ghcr.io/immich/server:latest'), update('vaultwarden', 'docker.io/vaultwarden/server:1.30')];
    render(<ImageUpdatesPendingBanner updates={updates} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: /update now/i }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith(updates);
  });

  it('disables the button and shows a running label while the update is in flight', async () => {
    let resolveUpdate: () => void = () => {};
    const onUpdate = vi.fn(() => new Promise<void>(resolve => { resolveUpdate = resolve; }));
    render(<ImageUpdatesPendingBanner updates={[update('immich', 'ghcr.io/immich/server:latest')]} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: /update now/i }));

    const runningBtn = await screen.findByRole('button', { name: /updating/i });
    expect((runningBtn as HTMLButtonElement).disabled).toBe(true);

    resolveUpdate();
    await waitFor(() => expect(screen.getByRole('button', { name: /update now/i })).toBeDefined());
  });
});
