/**
 * Secret-redaction helpers for MCP read tools (#321).
 *
 * Three of the read-scope MCP tools (`get_service_files`,
 * `get_service_logs`, `get_container_logs`) can otherwise hand back the
 * very secrets the operator typed into the install wizard:
 *
 *  - The kube YAML returned by `get_service_files` has env vars like
 *    `value: "<rendered SHARE_PASSWORD>"` inline.
 *  - Service journals catch any post-deploy log line that prints the
 *    rendered password (legacy 🔑 lines, replaced in #321).
 *  - Container logs catch the same thing for any service that prints
 *    its admin pwd at startup (e.g. filebrowser's first-run dump).
 *
 * The redactor walks raw text and rewrites recognised secret-looking
 * patterns to `<redacted>`. Optimised for our template conventions
 * rather than being heuristically clever — we'd rather over-redact
 * than under-redact, but we also don't want to break diff readability
 * for unrelated values.
 *
 * Two passes:
 *
 * 1. **Named env-var pairs** — kube YAML form. Match `name: SOMETHING`
 *    followed by `value: X` (across one line or two), where SOMETHING
 *    matches our convention of `*_PASSWORD`, `*_SECRET`, `*_TOKEN`,
 *    `*_KEY`, or `ACCOUNT_*`.
 *
 * 2. **Inline `key: value` patterns** — log form. Match
 *    `password[: =] <value>` and friends. Conservative — only matches
 *    explicit named patterns, not arbitrary 32-char strings (which
 *    would falsely redact UUIDs, container ids, etc.).
 */

const SENSITIVE_NAME =
  /(_PASSWORD|_SECRET|_TOKEN|_KEY|^ACCOUNT_[A-Za-z0-9]+|^PASSWORD$|^SECRET$|^TOKEN$)/;

/**
 * The mask string that MCP read tools (`get_service_files`, log tools)
 * substitute for a real secret value. Exported so the install path can
 * REJECT it if it ever leaks back in as a variable value (#2296): a
 * consumer that reads redacted variables and re-sends them must never
 * cause `<redacted>` to be persisted as a real secret.
 */
export const REDACTION_SENTINEL = '<redacted>';
const REDACTED = REDACTION_SENTINEL;

/**
 * Redact sensitive env-var pairs in a YAML/JSON-ish blob.
 *
 *   - name: SHARE_PASSWORD
 *     value: "FGhl06NSRwf…"     ← becomes value: "<redacted>"
 *
 * Also catches the same shape inline (`name: X, value: Y` on one line)
 * and the JSON variant (`"name": "X", "value": "Y"`).
 */
export function redactKubeYaml(text: string): string {
  if (!text) return text;

  // Two-line YAML form:
  //   - name: FOO_PASSWORD
  //     value: "..."           or   value: ...
  //
  // The character class is permissive enough for `ACCOUNT_samba` style
  // names (uppercase prefix, mixed-case suffix) while staying anchored
  // to the kube-env-var convention.
  const twoLine = /(\s*-?\s*name:\s*)(?:["']?)([A-Z][A-Za-z0-9_]*)(?:["']?)(\s*\n\s*value:\s*)(?:["']?)([^\n"']*)(?:["']?)/g;
  let out = text.replace(twoLine, (match, namePrefix, name, valuePrefix) => {
    if (!SENSITIVE_NAME.test(name)) return match;
    return `${namePrefix}${name}${valuePrefix}"${REDACTED}"`;
  });

  // JSON object form (single line):
  //   {"name":"FOO_PASSWORD","value":"..."}
  const jsonForm = /("name"\s*:\s*"([A-Z][A-Za-z0-9_]*)"[^}]*?"value"\s*:\s*")([^"]*)(")/g;
  out = out.replace(jsonForm, (match, prefix, name, _value, suffix) => {
    if (!SENSITIVE_NAME.test(name)) return match;
    return `${prefix}${REDACTED}${suffix}`;
  });

  return out;
}

/**
 * Redact recognised credential patterns inside a free-form log blob.
 *
 *   "password: hunter2"           → "password: <redacted>"
 *   "password=hunter2"            → "password=<redacted>"
 *   '"password": "hunter2"'       → '"password": "<redacted>"'
 *   "--password hunter2"          → "--password <redacted>"
 *   "password: `hunter2`"         → "password: `<redacted>`"  (#581)
 *   "?password=hunter2"           → "?password=<redacted>"    (#581)
 *   "password: |"                 → "password: |"             (#581)
 *   "  hunter2"                       "  <redacted>"
 *   "  more-secret-line"              "  <redacted>"
 *
 * Same set of trigger keywords as the YAML pass, plus a few that are
 * exclusively log-shaped (not env-var names): `Bearer <token>`,
 * `apikey=`, `api_key=`.
 */
export function redactLogText(text: string): string {
  if (!text) return text;

  const KEYWORDS = '(?:password|passwd|secret|token|api[_-]?key)';

  let out = text;

  // Multi-line YAML block scalar (#581):
  //   password: |
  //     line1
  //     line2
  // Run this first — operates line-by-line so it doesn't trip over the
  // single-line patterns below. The continuation lines are any lines
  // indented MORE than the key line; the block ends at the next line
  // with same-or-less indent (or EOF).
  out = redactYamlBlockScalars(out, KEYWORDS);

  // URL query strings FIRST (#581): the generic `key=X` pattern below
  // uses `\S+` which is too greedy in URL contexts (eats
  // `&format=json` past the secret value). Running the URL pattern
  // first lets each `[?&]key=value` segment be replaced in isolation,
  // leaving non-sensitive query params intact.
  //   https://example.com/api?password=hunter2&token=abc
  out = out.replace(
    new RegExp(`([?&]${KEYWORDS}=)([^&\\s"'\`]+)`, 'gi'),
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  // Order matters: handle quoted-keyword forms (JSON-style) next,
  // since the unquoted patterns below would otherwise eat just the
  // keyword and miss the leading `"`.

  // `"password": "X"`  (JSON / quoted keys, with optional whitespace)
  // Backtick alternative covers template-literal leaks from JS services.
  out = out.replace(
    new RegExp(`("${KEYWORDS}"\\s*:\\s*)(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`)`, 'gi'),
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  // `password=X`   `password="X"`   `password=\`X\``
  out = out.replace(
    new RegExp(`(${KEYWORDS}\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`|([^\\s&]+))`, 'gi'),
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  // `password: X`   (unquoted, log/YAML) — also backtick-quoted variant
  out = out.replace(
    new RegExp(`(${KEYWORDS}\\s*:\\s*)(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`|([^\\s&]+))`, 'gi'),
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  // `--password X`
  out = out.replace(
    new RegExp(`(--${KEYWORDS}\\s+)(?:"([^"]*)"|'([^']*)'|\`([^\`]*)\`|([^\\s&]+))`, 'gi'),
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  // `Authorization: Bearer X`
  out = out.replace(
    /(Bearer\s+)([^\s"'`]+)/g,
    (_m, prefix) => `${prefix}${REDACTED}`,
  );

  return out;
}

/**
 * Walk `text` line by line and replace YAML block-scalar bodies whose
 * key matches one of `keywordsAlternation` (anchored to a `|` or `>`
 * scalar header). Stops the block at the next line with same-or-less
 * indent than the key line. Conservative: only redacts the block body,
 * never the structural lines around it.
 */
function redactYamlBlockScalars(text: string, keywordsAlternation: string): string {
  const lines = text.split('\n');
  const headerRe = new RegExp(`^(\\s*)(${keywordsAlternation})\\s*:\\s*[|>][+\\-]?\\s*$`, 'i');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(headerRe);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    out.push(line); // keep the header
    const keyIndent = m[1].length;
    i++;
    // Consume continuation lines (indented MORE than the key). Replace
    // each non-blank one with the same indent + <redacted>. Blank lines
    // remain blank — they're part of the block but carry no content.
    while (i < lines.length) {
      const cont = lines[i];
      const indentMatch = cont.match(/^(\s*)/);
      const contIndent = indentMatch ? indentMatch[1].length : 0;
      if (cont.trim() === '') {
        out.push(cont);
        i++;
        continue;
      }
      if (contIndent <= keyIndent) break;
      out.push(' '.repeat(contIndent) + REDACTED);
      i++;
    }
  }
  return out.join('\n');
}

/** Redact a `getServiceFiles` payload — touches yamlContent +
 *  serviceContent (which can echo the env-vars too via systemctl
 *  cat output), plus the rendered kube file. Path fields stay as-is. */
export function redactServiceFiles<T extends {
  kubeContent?: string;
  yamlContent?: string;
  serviceContent?: string;
}>(files: T): T {
  return {
    ...files,
    kubeContent: redactKubeYaml(files.kubeContent ?? ''),
    yamlContent: redactKubeYaml(files.yamlContent ?? ''),
    serviceContent: redactKubeYaml(files.serviceContent ?? ''),
  };
}
