/**
 * The ONE place a **read-only** consumer resolves a template variable's
 * effective value (#2544).
 *
 * ## Why this module exists
 *
 * Four code paths in a row were written that answer "what is this
 * variable's value?" by hand, each one a private
 * `templateSettings[name] ?? meta.default` chain, and each one therefore
 * blind to whichever store it did not know about:
 *
 *   - #2530 — the install path re-read stale template specs;
 *   - #2531 — introduced `config.installedVariables`, the operator-set
 *     NON-secret store, and taught `assembleManifest` +
 *     `applyVariableDefaults` to read it back;
 *   - #2537 — `reconfigure-preview` blanked operator values because it
 *     had its own chain; fixed by routing it through the install path's
 *     `assembleManifest → applyVariableDefaults` pair;
 *   - #2544 — the health-probe view and the portal deep links, this
 *     module's two callers, were still on their own chains: an operator
 *     who changed a port in Configure got probed on, and deep-linked to,
 *     the template's DEFAULT port. A healthy service reported unhealthy
 *     forever; a portal card opened the wrong port.
 *
 * The proliferation is the bug. A consumer that only needs *values*
 * cannot reasonably drive `assembleManifest` (it resolves the registry,
 * mints secrets, and writes config), so #2537's answer does not
 * generalise to a read path — but the *precedence* must not be re-derived
 * either. This module is that precedence, once, for read paths.
 *
 * ## Precedence — mirrors `assembleManifest`, deliberately
 *
 *   1. `config.templateSettings[name]` — Settings → Template Settings,
 *      the operator's global override (`manifestAssembler.ts`,
 *      `globalSettings`).
 *   2. `config.installedVariables[name]` — the value the operator set on
 *      the last install of this variable's template (#2531,
 *      `loadSavedVariables`). Only genuinely operator-set values are
 *      stored, so a template that BUMPS a default still reaches a box
 *      that never overrode it (the #1297 contract).
 *   3. the template's `variables.json` `default`.
 *
 * A blank / whitespace-only value at any level is treated as absent and
 * falls through, and the result is returned trimmed — a port with a stray
 * newline is not a port.
 *
 * ## Secrets are deliberately NOT resolved here
 *
 * `loadSavedSecrets()` (#615, `config.installedSecrets`) is not consulted
 * and must not be: both callers render into an operator-visible surface —
 * a health probe URL and a portal card / deep link — where a credential
 * has no business. `loadSavedVariables` cannot leak one either
 * (`savedVariables.ts` refuses to store `secret | bcrypt | rsa-private`
 * types). A future consumer that legitimately needs a secret should reach
 * for `loadSavedSecrets` explicitly at its own call site, not widen this
 * one.
 */
import type { AppConfig } from '@/lib/config';
import { loadSavedVariables } from '@/lib/install/savedVariables';

/** The subset of a `variables.json` entry this module reads. Structural on
 *  purpose so both the registry's `VariableMeta` and the portal's local
 *  `{type?, default?, proxyPort?}` shape satisfy it. */
interface EffectiveVariableMeta {
  type?: string;
  default?: string;
}

/** `varName → variables.json entry` for ONE template. */
export type VariableDeclarations = Record<string, EffectiveVariableMeta | undefined>;

/** The config fields this resolution reads. Narrower than `AppConfig` so a
 *  caller that could not load config at all can pass `{}` and get
 *  defaults-only resolution through the same function, rather than
 *  hand-rolling a defaults-only fallback (which is how this class of bug
 *  starts). */
export type VariableConfigView = Pick<AppConfig, 'templateSettings' | 'installedVariables'>;

/** Trimmed value, or undefined when blank/absent. */
function nonBlank(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The precedence, implemented exactly once. Both exported entry points go
 * through this — that is the whole point of the module.
 *
 * `saved` is only consulted for a variable the template DECLARES.
 * `installedVariables` is a flat box-wide map (no template scoping), and
 * `collectVariableFills` in the install path likewise only fills declared
 * names — so an unrelated template's saved value can never bleed into this
 * template's render view.
 */
function pick(
  varName: string,
  settings: Record<string, string>,
  saved: Record<string, string>,
  declarations: VariableDeclarations,
): string | undefined {
  const override = nonBlank(settings[varName]);
  if (override) return override;
  if (Object.prototype.hasOwnProperty.call(declarations, varName)) {
    const operatorSet = nonBlank(saved[varName]);
    if (operatorSet) return operatorSet;
  }
  return nonBlank(declarations[varName]?.default);
}

/**
 * Effective value of ONE variable, or undefined when nothing resolves it.
 * Use when the caller already holds the template's declarations.
 */
export function resolveEffectiveVariable(
  config: VariableConfigView,
  declarations: VariableDeclarations | null | undefined,
  varName: string,
): string | undefined {
  return pick(varName, config.templateSettings ?? {}, loadSavedVariables(config), declarations ?? {});
}

/**
 * Effective values for a whole template, as a Mustache render view.
 *
 * Keys are the template's declared variables PLUS every
 * `templateSettings` key: an annotation may reference a global
 * (`PUBLIC_DOMAIN`, `DATA_DIR`) that this template's `variables.json` does
 * not declare, and the previous hand-rolled view copied all of
 * `templateSettings` wholesale for exactly that reason.
 */
export function buildEffectiveVariableView(
  config: VariableConfigView,
  declarations: VariableDeclarations | null | undefined,
): Record<string, string> {
  const settings = config.templateSettings ?? {};
  const saved = loadSavedVariables(config);
  const decls = declarations ?? {};
  const view: Record<string, string> = {};
  for (const name of new Set([...Object.keys(decls), ...Object.keys(settings)])) {
    const value = pick(name, settings, saved, decls);
    if (value !== undefined) view[name] = value;
  }
  return view;
}
