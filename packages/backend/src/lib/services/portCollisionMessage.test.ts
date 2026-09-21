/**
 * #2994 — the message is the fix, so the message is what gets asserted.
 *
 * The old text ended "Change the host port and retry." It was advice for one
 * situation and wrong for the common one: you are REPLACING what serves that
 * port, and the port is the whole point. A session that could not change the
 * port and could not remove the holder invented a third way — it redeployed the
 * holder with a placeholder image — and took a domain down.
 *
 * So these tests pin the two facts that were missing, and pin that the
 * workaround is named and refused rather than left as the only unblocked idea.
 */
import { describe, it, expect } from 'vitest';
import { describePortCollisions } from './portCollisionMessage';

const holder = (over: Partial<{ hostPort: number; serviceName: string; holderActive: boolean }> = {}) => ({
  hostPort: 8080, serviceName: 'asteroids-bubblegum', holderActive: true, ...over,
});

describe('describePortCollisions', () => {
  it('names the port, the holder, and whether the holder is running', () => {
    const m = describePortCollisions('Local', [holder()]);
    expect(m).toContain('port 8080');
    expect(m).toContain('asteroids-bubblegum');
    expect(m).toContain('running');
  });

  it('says that stopping the holder did not release the port', () => {
    // The exact confusion that produced the incident: the session had ALREADY
    // stopped the holder and was still refused.
    const m = describePortCollisions('Local', [holder({ holderActive: false })]);
    expect(m).toContain('installed but stopped');
    expect(m).toContain('does NOT release its port');
  });

  it('does not claim a running holder was stopped', () => {
    const m = describePortCollisions('Local', [holder({ holderActive: true })]);
    expect(m).not.toContain('does NOT release its port');
  });

  it('offers the two exits that actually resolve it, naming the holder', () => {
    const m = describePortCollisions('Local', [holder()]);
    expect(m).toContain('recipe-roll-new-image-to-running-service');
    expect(m).toContain('servicebay request-remove asteroids-bubblegum');
  });

  it('no longer opens with "change the host port" — that is the last resort now', () => {
    const m = describePortCollisions('Local', [holder()]);
    const rollAt = m.indexOf('roll the new image');
    const portAt = m.indexOf('different host port');
    expect(rollAt).toBeGreaterThan(-1);
    expect(portAt).toBeGreaterThan(rollAt);
    expect(m).toContain('Only if this really is a NEW service');
  });

  it('names the workaround that caused the incident and refuses it', () => {
    const m = describePortCollisions('Local', [holder()]);
    expect(m).toContain('Do not redeploy the holder with a placeholder');
  });

  it('handles several holders without inventing a single one', () => {
    const m = describePortCollisions('Local', [
      holder({ hostPort: 8080, serviceName: 'a' }),
      holder({ hostPort: 9090, serviceName: 'b', holderActive: false }),
    ]);
    expect(m).toContain('port 8080 is owned by a (running)');
    expect(m).toContain('port 9090 is owned by b (installed but stopped)');
    expect(m).toContain('request-remove <service>');
    // With two holders it must not name one of them as THE thing to replace.
    expect(m).not.toContain('request-remove a ');
  });

  it('still names the node, so a multi-node deploy says where', () => {
    expect(describePortCollisions('kitchen-pi', [holder()])).toContain('"kitchen-pi"');
  });
});
