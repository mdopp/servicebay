/**
 * The one Mustache renderer (#599).
 *
 * Both `install/runner.ts` (deploy-time render) and
 * `api/services/[name]/reconfigure-preview/route.ts` (preview-time
 * render) used to import `mustache` directly. The depcruise
 * `one-renderer` rule called this out as a coupling smell — having
 * two renderers means the deploy path can render differently from
 * what the preview showed. This module is the single funnel.
 *
 * Both consumers use the same configuration: HTML escaping disabled
 * (we render YAML and config files, not HTML). The wrapper restores
 * the global escape setting after every call so a parallel render of
 * actual HTML elsewhere wouldn't be affected — Mustache's escape
 * function is module-global.
 *
 * Adding a new render call site? Import from here. Direct
 * `import 'mustache'` outside this module is blocked by
 * `.dependency-cruiser.cjs:one-renderer`.
 */

import Mustache from 'mustache';

/** Render `template` against `view`, with HTML escaping disabled so
 *  YAML strings and shell scripts pass through verbatim. */
export function renderTemplate(template: string, view: Record<string, unknown>): string {
  const savedEscape = Mustache.escape;
  Mustache.escape = (text: string) => text;
  try {
    return Mustache.render(template, view);
  } finally {
    Mustache.escape = savedEscape;
  }
}
