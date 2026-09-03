/**
 * MCP token scope mapping + back-compat tests (#591).
 *
 * The audit flagged that `update_config` was tagged `destroy` even
 * though it's allow-listed to safe keys — and `exec_command` shared
 * the same scope, so a token couldn't get "edit config but no shell".
 * This commit downgrades `update_config` to `mutate` and splits
 * `exec_command` into its own `exec` scope, with a back-compat rule
 * that existing `destroy` tokens still get `exec`.
 *
 * #2623 removed that back-compat rule: it re-merged the tier #591 had just
 * split, so `destroy` silently meant shell — for the majority of live tokens
 * and for every admin browser session. `exec` is now held only where it was
 * granted explicitly, and the last describe block is the exhaustive ratchet
 * that keeps any implication from creeping back.
 *
 * These tests pin the scope table + the implication rules. Future
 * regressions would surface here before reaching any deployed token.
 */

import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { TOOL_SCOPES, tokenHasScope } from '@/lib/mcp/server';
import { ALL_SCOPES, scopeSatisfiedBy, type ApiScope } from '@/lib/auth/apiScope';

describe('MCP scope mapping (#591)', () => {
  it('update_config is mutate, not destroy', () => {
    expect(TOOL_SCOPES.update_config).toBe('mutate');
  });

  it('exec_command is exec, not destroy', () => {
    expect(TOOL_SCOPES.exec_command).toBe('exec');
  });

  it('set_boot_next_usb is destroy', () => {
    expect(TOOL_SCOPES.set_boot_next_usb).toBe('destroy');
  });

  it('reboot_node is reboot, not destroy (#1765)', () => {
    // A reboot is transient/recoverable — split out of `destroy` so a token
    // can operate+reboot without also granting irreversible delete/wipe.
    expect(TOOL_SCOPES.reboot_node).toBe('reboot');
  });

  it('factory_reset is destroy (#1237)', () => {
    expect(TOOL_SCOPES.factory_reset).toBe('destroy');
  });

  it('every entry uses one of the known scopes', () => {
    const known: ReadonlySet<ApiScope> = new Set<ApiScope>(ALL_SCOPES);
    for (const [tool, scope] of Object.entries(TOOL_SCOPES)) {
      expect(known.has(scope), `${tool} has unknown scope ${scope}`).toBe(true);
    }
  });
});

describe('tokenHasScope — least-privilege check', () => {
  it('grants when the required scope is in the token', () => {
    expect(tokenHasScope(['mutate'], 'mutate')).toBe(true);
    expect(tokenHasScope(['read', 'lifecycle'], 'lifecycle')).toBe(true);
  });

  it('refuses when the required scope is missing', () => {
    expect(tokenHasScope(['read'], 'mutate')).toBe(false);
    expect(tokenHasScope(['read', 'lifecycle'], 'destroy')).toBe(false);
  });

  // The ticket's required test: a token with [mutate] can call
  // update_config but is refused for exec_command.
  it('[mutate] token: allowed for update_config, refused for exec_command', () => {
    const scopes: ApiScope[] = ['mutate'];
    expect(tokenHasScope(scopes, TOOL_SCOPES.update_config)).toBe(true);
    expect(tokenHasScope(scopes, TOOL_SCOPES.exec_command)).toBe(false);
  });

  // #2623: the pre-#591 back-compat carve-out is GONE. `destroy` no longer
  // hands out shell — it re-merged the tier #591 had split, so 20 of 34 live
  // tokens (and every admin browser session, via the /mcp cookie bridge) had
  // exec nobody granted them.
  it('[destroy] token does NOT get exec (#2623 — the implication is gone)', () => {
    const scopes: ApiScope[] = ['destroy'];
    expect(tokenHasScope(scopes, 'exec')).toBe(false);
    expect(tokenHasScope(scopes, TOOL_SCOPES.exec_command)).toBe(false);
    expect(tokenHasScope(scopes, TOOL_SCOPES.container_exec)).toBe(false);
    // ... and it never granted mutate or the lower tiers by transitivity:
    expect(tokenHasScope(scopes, 'mutate')).toBe(false);
    expect(tokenHasScope(scopes, 'lifecycle')).toBe(false);
    expect(tokenHasScope(scopes, 'read')).toBe(false);
  });

  // #1765: the reboot tier was carved out of destroy, so legacy destroy
  // tokens must still be able to reboot a node.
  it('[destroy] token implicitly gets reboot (back-compat with pre-#1765 tokens)', () => {
    expect(tokenHasScope(['destroy'], 'reboot')).toBe(true);
    expect(tokenHasScope(['destroy'], TOOL_SCOPES.reboot_node)).toBe(true);
  });

  it('[reboot] alone does not imply destroy actions', () => {
    expect(tokenHasScope(['reboot'], TOOL_SCOPES.reboot_node)).toBe(true);
    expect(tokenHasScope(['reboot'], TOOL_SCOPES.delete_service)).toBe(false);
    expect(tokenHasScope(['reboot'], TOOL_SCOPES.factory_reset)).toBe(false);
  });

  it('[exec] alone is sufficient for exec_command but not for destroy actions', () => {
    const scopes: ApiScope[] = ['exec'];
    expect(tokenHasScope(scopes, TOOL_SCOPES.exec_command)).toBe(true);
    expect(tokenHasScope(scopes, TOOL_SCOPES.delete_service)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RATCHET (#2623) — `exec` is reachable ONLY by an explicit grant.
//
// The implication that had to go (`destroy ⇒ exec`) was one line, and the same
// line can come back as a "back-compat" convenience the next time a token
// somewhere gets refused. So this is not a spot-check of `['destroy']`: it is
// EXHAUSTIVE over every subset of the scope ladder. Any future rule — from any
// scope, or from a combination — that lets `scopeSatisfiedBy` answer `true` for
// `exec` without `exec` in the held set fails here, naming the culprit set.
// ---------------------------------------------------------------------------

describe('scopeSatisfiedBy: exec is never implied (#2623 ratchet)', () => {
  /** Every subset of ALL_SCOPES (2^7 = 128 sets). */
  function allSubsets(scopes: readonly ApiScope[]): ApiScope[][] {
    return scopes.reduce<ApiScope[][]>(
      (acc, s) => [...acc, ...acc.map(sub => [...sub, s])],
      [[]],
    );
  }

  const subsets = allSubsets(ALL_SCOPES);

  it('no scope set WITHOUT exec ever satisfies exec', () => {
    const leaks = subsets
      .filter(held => !held.includes('exec'))
      .filter(held => scopeSatisfiedBy(held, 'exec') || tokenHasScope(held, 'exec'));
    expect(
      leaks.map(l => `[${l.join(',')}]`),
      'these scope sets derive exec without holding it — an implication crept back in',
    ).toEqual([]);
  });

  it('every scope set WITH exec still satisfies exec (the ratchet did not over-tighten)', () => {
    const denied = subsets
      .filter(held => held.includes('exec'))
      .filter(held => !scopeSatisfiedBy(held, 'exec'));
    expect(denied.map(l => `[${l.join(',')}]`)).toEqual([]);
  });

  it('the exec-gated tools are reachable only with an explicit exec grant', () => {
    for (const tool of ['exec_command', 'container_exec'] as const) {
      expect(TOOL_SCOPES[tool], `${tool} must stay exec-tier`).toBe('exec');
      expect(tokenHasScope(['destroy'], TOOL_SCOPES[tool]), tool).toBe(false);
      expect(tokenHasScope(['exec'], TOOL_SCOPES[tool]), tool).toBe(true);
    }
  });

  // The surviving carve-out, pinned so the ratchet can't be "fixed" by deleting
  // the wrong line: #1765's destroy ⇒ reboot stays.
  it('keeps destroy ⇒ reboot (#1765) — only the exec implication was removed', () => {
    expect(scopeSatisfiedBy(['destroy'], 'reboot')).toBe(true);
  });

  // Criterion: the /mcp cookie bridge must not regain exec, implicitly or
  // literally. Read the real grant out of server.ts and run it through the real
  // gate — an edit that adds 'exec' to that array, or an implication that hands
  // it over, fails here.
  it('the /mcp cookie-session bridge does not hold exec', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'backend', 'src', 'server.ts'),
      'utf-8',
    );
    const m = src.match(/scopes: session\.scopes \?\? \[([^\]]*)\]/);
    expect(m, 'the cookie-session bridge grant moved — re-point this guard').not.toBeNull();
    const granted = m![1]
      .split(',')
      .map(s => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean) as ApiScope[];
    expect(granted).not.toContain('exec');
    expect(tokenHasScope(granted, 'exec'), 'a browser session must not reach exec_command').toBe(false);
    // It keeps the rest of the operator surface, including reboot by implication.
    expect(tokenHasScope(granted, 'destroy')).toBe(true);
    expect(tokenHasScope(granted, 'reboot')).toBe(true);
  });

  // #2768: the broad set above is the fallback for a scope-less (password-login)
  // cookie ONLY. A bridged session minted by /api/auth/session-from-token carries
  // the source token's `scopes`, and /mcp must honour those instead — otherwise a
  // `read`-only token traded for a cookie becomes a full operator over MCP.
  it('the /mcp cookie bridge prefers the session own scopes over the broad fallback', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'backend', 'src', 'server.ts'),
      'utf-8',
    );
    expect(
      /scopes: session\.scopes \?\? \[/.test(src),
      'the /mcp cookie fallback must read session.scopes when present (#2768)',
    ).toBe(true);
    // And the broad literal must never be handed out unconditionally again.
    expect(src).not.toMatch(/auth = \{ user: session\.user, scopes: \['read'/);
  });
});
