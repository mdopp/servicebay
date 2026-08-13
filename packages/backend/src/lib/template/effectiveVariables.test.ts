import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveVariable,
  buildEffectiveVariableView,
  type VariableConfigView,
} from './effectiveVariables';

/**
 * #2544 — the shared read-path resolver. These pin the precedence itself;
 * the two consumers (health probe URLs, portal deep links) have their own
 * regression tests that prove they go through this.
 */
const cfg = (over: Partial<VariableConfigView> = {}): VariableConfigView => ({
  templateSettings: {},
  installedVariables: [],
  ...over,
});

describe('resolveEffectiveVariable — precedence mirrors the install path', () => {
  const decls = { PORT: { type: 'text', default: '8080' } };

  it('falls back to the template default when nothing is set', () => {
    expect(resolveEffectiveVariable(cfg(), decls, 'PORT')).toBe('8080');
  });

  it('prefers an operator-set value from installedVariables over the default', () => {
    const config = cfg({ installedVariables: [{ varName: 'PORT', value: '9999' }] });
    expect(resolveEffectiveVariable(config, decls, 'PORT')).toBe('9999');
  });

  it('prefers a global Template Setting over the operator-set value', () => {
    const config = cfg({
      templateSettings: { PORT: '7777' },
      installedVariables: [{ varName: 'PORT', value: '9999' }],
    });
    expect(resolveEffectiveVariable(config, decls, 'PORT')).toBe('7777');
  });

  it('treats a blank value at any level as absent and falls through', () => {
    const config = cfg({
      templateSettings: { PORT: '   ' },
      installedVariables: [{ varName: 'PORT', value: '' }],
    });
    expect(resolveEffectiveVariable(config, decls, 'PORT')).toBe('8080');
  });

  it('trims the resolved value — a port with a stray newline is not a port', () => {
    const config = cfg({ installedVariables: [{ varName: 'PORT', value: ' 9999\n' }] });
    expect(resolveEffectiveVariable(config, decls, 'PORT')).toBe('9999');
  });

  it('returns undefined when the variable resolves to nothing at all', () => {
    expect(resolveEffectiveVariable(cfg(), { PORT: {} }, 'PORT')).toBeUndefined();
    expect(resolveEffectiveVariable(cfg(), decls, 'NOPE')).toBeUndefined();
  });

  it('does not let another template\'s saved value bleed into an undeclared name', () => {
    // installedVariables is a flat, box-wide map. The install path's
    // collectVariableFills only fills DECLARED names; so does this.
    const config = cfg({ installedVariables: [{ varName: 'OTHER_PORT', value: '4444' }] });
    expect(resolveEffectiveVariable(config, decls, 'OTHER_PORT')).toBeUndefined();
  });

  it('never reads installedSecrets — a secret cannot reach a probe URL or a card', () => {
    const config = {
      ...cfg({ installedVariables: [] }),
      // Shape of the #615 store, deliberately not consulted here.
      installedSecrets: [{ varName: 'TOKEN', value: 'super-secret' }],
    } as VariableConfigView;
    expect(resolveEffectiveVariable(config, { TOKEN: { type: 'secret' } }, 'TOKEN')).toBeUndefined();
  });
});

describe('buildEffectiveVariableView', () => {
  it('resolves every declared variable through the same precedence', () => {
    const config = cfg({
      templateSettings: { A: 'from-settings' },
      installedVariables: [{ varName: 'B', value: 'from-operator' }],
    });
    const view = buildEffectiveVariableView(config, {
      A: { default: 'a-default' },
      B: { default: 'b-default' },
      C: { default: 'c-default' },
    });
    expect(view).toEqual({ A: 'from-settings', B: 'from-operator', C: 'c-default' });
  });

  it('keeps globals that the template does not declare (PUBLIC_DOMAIN, DATA_DIR)', () => {
    const config = cfg({ templateSettings: { PUBLIC_DOMAIN: 'example.com' } });
    expect(buildEffectiveVariableView(config, { PORT: { default: '80' } })).toEqual({
      PUBLIC_DOMAIN: 'example.com',
      PORT: '80',
    });
  });

  it('omits a variable that resolves to nothing rather than emitting an empty key', () => {
    expect(buildEffectiveVariableView(cfg(), { PORT: {} })).toEqual({});
  });

  it('an unreadable config resolves defaults-only through the same function', () => {
    expect(buildEffectiveVariableView({}, { PORT: { default: '8080' } })).toEqual({ PORT: '8080' });
  });
});
