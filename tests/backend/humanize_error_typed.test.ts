/**
 * Wording-independence tests for the DomainError typed path (#598).
 *
 * Verifies that SSHError + AgentTimeoutError humanize via the typed
 * switch — not via the regex fallback. If ssh2 or any other upstream
 * library changes its error wording, these tests still pass because
 * the typed path doesn't look at `.message`.
 */

import { describe, it, expect } from 'vitest';
import { humanizeError } from '../../src/lib/util/humanizeError';
import { SSHError, AgentTimeoutError } from '../../src/lib/util/domainError';

describe('humanizeError — typed DomainError path (#598)', () => {
  it('routes SSHError(auth) to the "SSH authentication failed" title regardless of message', () => {
    // Deliberately bogus message — nothing the regex would match.
    const err = new SSHError({
      nodeName: 'edge-node',
      reason: 'auth',
      message: 'zzz-completely-random-wording-that-no-regex-knows',
    });
    const out = humanizeError(err);
    expect(out.title).toBe('SSH authentication failed');
    expect(out.detail).toContain('edge-node');
    expect(out.detail).toMatch(/Settings → Nodes/);
  });

  it.each([
    ['dns', 'Node not reachable', /resolve hostname/i],
    ['refused', 'Node not reachable', /refused/i],
    ['timeout', 'Node not reachable', /timeout/i],
  ] as const)('routes SSHError(%s) without touching the message regex', (reason, title, detailRe) => {
    const err = new SSHError({
      nodeName: 'home-srv',
      reason,
      message: 'an unrelated string the regex would never match',
    });
    const out = humanizeError(err);
    expect(out.title).toBe(title);
    expect(out.detail).toMatch(detailRe);
  });

  it('routes AgentTimeoutError via the typed switch, not the timeout regex', () => {
    // Construct one with a message that wouldn't even match TIMEOUT_RX.
    const err = new AgentTimeoutError({ action: 'list_units', timeoutMs: 30000 });
    const out = humanizeError(err);
    expect(out.title).toBe('Agent request timed out');
    expect(out.detail).toMatch(/Settings → Nodes/);
  });

  it('falls through to the regex matcher for plain Error instances', () => {
    // Plain Error with timeout text — exercises the regex fallback path.
    const out = humanizeError(new Error('Operation timed out after 5s'));
    expect(out.title).toBe('Request timed out');
  });

  it('returns the fallback title when nothing matches', () => {
    const out = humanizeError(new Error('completely-unrecognised-failure-mode'));
    expect(out.title).toBe('Something went wrong');
    expect(out.detail).toContain('completely-unrecognised-failure-mode');
  });
});
