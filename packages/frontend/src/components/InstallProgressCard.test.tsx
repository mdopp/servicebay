/**
 * InstallProgressCardView (#A) — the presentational half of the Home
 * install-progress card. Renders current item, deployed/total, percent,
 * log tail, and a skip-credentials affordance only on needs_credentials.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstallProgressCardView } from './InstallProgressCard';
import type { InstallMonitorState } from '@/hooks/useInstallMonitor';

const base: InstallMonitorState = {
  jobId: 'job-1',
  phase: 'running',
  currentItem: 'immich',
  deployed: 3,
  total: 6,
  percent: 50,
  needsCredentials: false,
  logs: ['🔑 Reusing 7 saved secrets', 'Deploying immich…'],
  postDeployProgress: null,
};

describe('InstallProgressCardView', () => {
  it('renders the current item, deployed/total and log tail', () => {
    render(<InstallProgressCardView state={base} onSkipCredentials={() => {}} />);
    expect(screen.getByText('· immich')).toBeDefined();
    expect(screen.getByText('3/6')).toBeDefined();
    expect(screen.getByText('50%')).toBeDefined();
    expect(screen.getByText(/Reusing 7 saved secrets/)).toBeDefined();
  });

  it('hides the skip-credentials button unless waiting on credentials', () => {
    render(<InstallProgressCardView state={base} onSkipCredentials={() => {}} />);
    expect(screen.queryByText(/skip credentials/i)).toBeNull();
  });

  it('shows and wires the skip-credentials button on needs_credentials', () => {
    const onSkip = vi.fn();
    render(
      <InstallProgressCardView
        state={{ ...base, phase: 'needs_credentials', needsCredentials: true }}
        onSkipCredentials={onSkip}
      />,
    );
    const btn = screen.getByText(/skip credentials/i).closest('button')!;
    fireEvent.click(btn);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('renders no post-deploy bar when none is in flight', () => {
    render(<InstallProgressCardView state={base} onSkipCredentials={() => {}} />);
    expect(screen.queryByText(/ollama:pull/)).toBeNull();
    expect(screen.queryByText(/MB/)).toBeNull();
  });

  it('renders the post-deploy progress bar with tag and MB readout', () => {
    render(
      <InstallProgressCardView
        state={{
          ...base,
          postDeployProgress: { tag: 'ollama:pull', percent: 42, completedMb: 4200, totalMb: 10000 },
        }}
        onSkipCredentials={() => {}}
      />,
    );
    expect(screen.getByText('ollama:pull')).toBeDefined();
    expect(screen.getByText('4200 / 10000 MB · 42%')).toBeDefined();
  });

  it('falls back to percent-only when MB fields are absent', () => {
    render(
      <InstallProgressCardView
        state={{ ...base, postDeployProgress: { tag: 'ollama:pull', percent: 7 } }}
        onSkipCredentials={() => {}}
      />,
    );
    expect(screen.getByText('7%')).toBeDefined();
    expect(screen.queryByText(/MB/)).toBeNull();
  });
});
