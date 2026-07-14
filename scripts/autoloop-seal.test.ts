import { describe, it, expect } from 'vitest';
import { isPathMandated, PATH_MANDATED_PATHS } from './autoloop-seal';

describe('isPathMandated', () => {
  it('matches install/deploy path files (this session: #2296 runner.ts)', () => {
    expect(isPathMandated('packages/backend/src/lib/install/runner.ts')).toBe(true);
    expect(isPathMandated('packages/backend/src/lib/config.ts')).toBe(true);
    expect(isPathMandated('packages/backend/src/lib/systemBackup.ts')).toBe(true);
  });

  it('matches the NPM-render + proxy-gate files this session proved need verify', () => {
    // #2278/#2281 forward-auth render + proxy gate — absent from the old builder.md list.
    expect(isPathMandated('packages/backend/src/lib/stackInstall/forwardAuth.ts')).toBe(true);
    expect(isPathMandated('packages/backend/src/lib/portal/provisioner.ts')).toBe(true);
    expect(isPathMandated('packages/frontend/src/proxy.ts')).toBe(true);
  });

  it('matches user-facing surfaces (portal / dashboard / the wizard file)', () => {
    expect(isPathMandated('packages/frontend/src/app/portal/PortalGrid.tsx')).toBe(true);
    expect(isPathMandated('packages/frontend/src/app/(dashboard)/settings/page.tsx')).toBe(true);
    expect(isPathMandated('packages/frontend/src/components/OnboardingWizard.tsx')).toBe(true);
  });

  it('does NOT match unrelated / pure-logic files', () => {
    expect(isPathMandated('packages/backend/src/lib/auth/apiTokens.ts')).toBe(false);
    expect(isPathMandated('packages/backend/src/lib/stackInstall/nginxScratchValidate.ts')).toBe(true); // stackInstall/ IS mandated
    expect(isPathMandated('scripts/autoloop-seal.ts')).toBe(false);
    expect(isPathMandated('docs/ARCHITECTURE_INVARIANTS.md')).toBe(false);
    expect(isPathMandated('packages/frontend/src/hooks/useServiceActions.tsx')).toBe(false);
  });

  it('exact-matches file entries, prefix-matches directory entries', () => {
    // proxy.ts is an exact file entry — a sibling must NOT match.
    expect(isPathMandated('packages/frontend/src/proxyOther.ts')).toBe(false);
    // config.ts exact — config.helper.ts must NOT match.
    expect(isPathMandated('packages/backend/src/lib/configLoader.ts')).toBe(false);
  });

  it('every directory entry ends with a slash and every list entry is under packages/', () => {
    for (const p of PATH_MANDATED_PATHS) {
      expect(p.startsWith('packages/')).toBe(true);
      // a heuristic guard: entries without an extension must be directories (trailing /)
      const last = p.split('/').pop() ?? '';
      if (!last.includes('.')) expect(p.endsWith('/')).toBe(true);
    }
  });
});
