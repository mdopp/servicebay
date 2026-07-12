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

/**
 * Render a POD/quadlet YAML template (#2206).
 *
 * Pod templates carry variable values inside **double-quoted YAML scalars**
 * (`value: "{{VAPID_PRIVATE_KEY}}"`). A value that contains a raw newline
 * (a multi-line PEM private key, a wrapped token) substituted verbatim splits
 * the scalar across lines, and podman's Go YAML parser rejects the result
 * (`yaml: line NNN: could not find expected ':'`) → the pod crash-loops on the
 * next restart, long after the install that wrote it. js-yaml tolerates the
 * folded newline, so this only bites the real box.
 *
 * The fix escapes control characters (backslash first, then newline / carriage
 * return / tab) in every string value, so they emit as YAML escape sequences
 * (`\n`, `\r`, `\t`) inside the double-quoted scalar — valid in *every* YAML
 * parser and a faithful round-trip back to the original value. This is applied
 * ONLY to pod YAML; config-file rendering keeps real newlines (a PEM written to
 * a config file needs its literal line breaks).
 */
export function renderPodYaml(template: string, view: Record<string, unknown>): string {
  const escaped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(view)) {
    escaped[k] = typeof v === 'string' ? escapeYamlScalar(v) : v;
  }
  return renderTemplate(template, escaped);
}

/** Escape control chars so a value survives inside a double-quoted YAML
 *  scalar. Backslash must be escaped first, or the escapes we add would be
 *  double-escaped. The double-quote must also be escaped (`\"`), or a value
 *  containing a `"` closes the scalar early → invalid YAML → the pod
 *  crash-loops on the next restart (same failure class as an unescaped
 *  newline, #2224). Exported for the runner's empty-var detection, which
 *  must compare against the pre-render view. */
export function escapeYamlScalar(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
