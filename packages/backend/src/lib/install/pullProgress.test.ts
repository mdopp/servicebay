import { describe, it, expect } from 'vitest';
import { PullTracker, describePull, type PullEvent } from './pullProgress';

// Trivial byte formatter so the assertions stay readable.
const fmt = (n: number) => `${n}B`;

describe('PullTracker', () => {
  it('counts cached ("Already exists") layers separately from downloads', () => {
    // Shape captured from podman docker-compat /images/create.
    const events: PullEvent[] = [
      { id: 'a', status: 'Already exists' },
      { id: 'b', status: 'Pulling fs layer' },
      { id: 'b', status: 'Downloading', current: 50, total: 100 },
    ];
    const t = new PullTracker();
    events.forEach(e => t.update(e));
    const s = t.summary();
    expect(s.cached).toBe(1);
    expect(s.totalLayers).toBe(2);
    expect(s.bytesCurrent).toBe(50);
    expect(s.bytesTotal).toBe(100);
  });

  it('credits a completed layer its full size even though the done event has no bytes', () => {
    const t = new PullTracker();
    t.update({ id: 'b', status: 'Downloading', current: 60, total: 100 });
    t.update({ id: 'b', status: 'Download complete' }); // empty progressDetail
    const s = t.summary();
    expect(s.bytesCurrent).toBe(100);
    expect(s.bytesTotal).toBe(100);
    expect(s.complete).toBe(1);
  });

  it('aggregates byte progress across multiple downloading layers', () => {
    const t = new PullTracker();
    t.update({ id: 'x', status: 'Downloading', current: 1_000_000, total: 2_000_000 });
    t.update({ id: 'y', status: 'Downloading', current: 500_000, total: 4_000_000 });
    const s = t.summary();
    expect(s.bytesCurrent).toBe(1_500_000);
    expect(s.bytesTotal).toBe(6_000_000);
  });

  it('ignores events without a layer id', () => {
    const t = new PullTracker();
    t.update({ status: 'Trying to pull …' });
    expect(t.summary().totalLayers).toBe(0);
  });
});

describe('describePull', () => {
  it('shows percent + bytes + cached count once sizes are known', () => {
    const t = new PullTracker();
    t.update({ id: 'a', status: 'Already exists' });
    t.update({ id: 'b', status: 'Downloading', current: 25, total: 100 });
    expect(describePull('ollama', t.summary(), fmt)).toBe('Pulling ollama: 25% (25B / 100B) · 1 layer already cached');
  });

  it('shows a preparing heartbeat before any byte sizes arrive', () => {
    const t = new PullTracker();
    t.update({ id: 'a', status: 'Already exists' });
    t.update({ id: 'b', status: 'Pulling fs layer' });
    expect(describePull('ollama', t.summary(), fmt)).toBe('Pulling ollama: preparing 2 layers · 1 layer already cached…');
  });

  it('returns null before any layer is seen', () => {
    expect(describePull('ollama', new PullTracker().summary(), fmt)).toBeNull();
  });
});
