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
 * These tests pin the scope table + the back-compat rule. Future
 * regressions would surface here before reaching any deployed token.
 */

import { describe, it, expect } from 'vitest';
import { TOOL_SCOPES, tokenHasScope } from '@/lib/mcp/server';
import type { ApiScope } from '@/lib/mcp/tokens';

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

  it('reboot_node is destroy (#1235)', () => {
    expect(TOOL_SCOPES.reboot_node).toBe('destroy');
  });

  it('every entry uses one of the five known scopes', () => {
    const known: ReadonlySet<ApiScope> = new Set<ApiScope>(['read', 'lifecycle', 'mutate', 'destroy', 'exec']);
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

  // Back-compat per the issue's migration note.
  it('[destroy] token implicitly gets exec (back-compat with pre-#591 tokens)', () => {
    const scopes: ApiScope[] = ['destroy'];
    expect(tokenHasScope(scopes, 'exec')).toBe(true);
    // ... but doesn't grant mutate or other scopes by transitivity:
    expect(tokenHasScope(scopes, 'mutate')).toBe(false);
    expect(tokenHasScope(scopes, 'lifecycle')).toBe(false);
    expect(tokenHasScope(scopes, 'read')).toBe(false);
  });

  it('[exec] alone is sufficient for exec_command but not for destroy actions', () => {
    const scopes: ApiScope[] = ['exec'];
    expect(tokenHasScope(scopes, TOOL_SCOPES.exec_command)).toBe(true);
    expect(tokenHasScope(scopes, TOOL_SCOPES.delete_service)).toBe(false);
  });
});
