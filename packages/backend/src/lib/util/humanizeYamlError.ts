/**
 * Translate a `js-yaml` parse error into a plain-English message
 * (#729). The library renders messages like:
 *
 *     end of the stream or a document separator is expected at line 14, column 1:
 *
 * which is technically accurate but reads as gibberish to anyone who
 * hasn't worked with libyaml internals. This helper detects the
 * common cases and rewrites them; everything else passes through
 * unchanged so we never lose information.
 *
 * The output is `{ message, line, column }` so the caller can both
 * surface the short text and highlight the offending row in the
 * editor — see `ServiceForm.tsx`.
 */

export interface HumanizedYamlError {
  /** Short user-facing summary. */
  message: string;
  /** 1-based line number of the failure, when known. */
  line?: number;
  /** 1-based column number, when known. */
  column?: number;
  /** Original raw message — surfaced as a "Details" disclosure in the UI. */
  raw: string;
}

interface YamlMark {
  line?: number;
  column?: number;
  position?: number;
}

interface ParsedRaw {
  rawMessage: string;
  reason: string;
  mark: YamlMark | null;
}

function parseRaw(err: unknown): ParsedRaw {
  if (err && typeof err === 'object') {
    const e = err as { message?: string; reason?: string; mark?: YamlMark; toString?: () => string };
    const rawMessage = typeof e.message === 'string' && e.message.length > 0
      ? e.message
      : (typeof e.toString === 'function' ? e.toString() : String(err));
    return {
      rawMessage,
      reason: typeof e.reason === 'string' ? e.reason : rawMessage,
      mark: e.mark ?? null,
    };
  }
  return { rawMessage: String(err), reason: String(err), mark: null };
}

/** Concrete cases worth rewriting. Order matters: more specific
 *  matches must come first. */
const RULES: { match: RegExp; rewrite: (raw: string) => string }[] = [
  {
    match: /end of the stream or a document separator is expected/i,
    rewrite: () =>
      'Unexpected content — expected the document to end here. Likely a stray character (often an extra `---`, a tab in indentation, or a trailing colon) on the line below.',
  },
  {
    match: /could not find expected ':'/i,
    rewrite: () =>
      'Missing `:` after a key. Each YAML key needs a colon and a space before its value (e.g. `name: my-service`).',
  },
  {
    match: /(mapping values are not allowed|expected.*scalar.*mapping)/i,
    rewrite: () =>
      'Two colons on one line. The parser saw a key whose value also contains a `:`. Wrap the value in quotes: `image: "docker.io/foo:latest"`.',
  },
  {
    match: /(bad indentation of a mapping entry|expected.*indent)/i,
    rewrite: () =>
      'Indentation problem. YAML uses spaces (not tabs) and every nested level must be at least 2 spaces deeper than its parent.',
  },
  {
    match: /(can not read a block mapping entry|expected.*block.*mapping)/i,
    rewrite: () =>
      'A list item or nested block is missing its leading `- ` / proper indent. Check that every list entry starts with `- ` and that nested fields are indented under it.',
  },
  {
    match: /duplicated mapping key/i,
    rewrite: () =>
      'Duplicate key — the same field is listed twice in this block. Remove one, or merge their values into a single entry.',
  },
  {
    match: /unexpected end of the stream within a (flow|double-quoted|single-quoted) scalar/i,
    rewrite: () =>
      'Unterminated quoted string or bracket. A `"` / `\'` / `[` / `{` was opened and never closed before the file ended.',
  },
  {
    match: /tab characters/i,
    rewrite: () =>
      'Tab character used for indentation. YAML only allows spaces — replace tabs with two spaces per indent level.',
  },
];

export function humanizeYamlError(err: unknown): HumanizedYamlError {
  const { rawMessage, reason, mark } = parseRaw(err);
  // `js-yaml` reports lines and columns as 0-based; UIs and human
  // conventions are 1-based, so add 1 when we know the value.
  const line = typeof mark?.line === 'number' ? mark.line + 1 : undefined;
  const column = typeof mark?.column === 'number' ? mark.column + 1 : undefined;
  const locator = line ? ` Line ${line}${column ? `:${column}` : ''}.` : '';

  for (const rule of RULES) {
    if (rule.match.test(reason) || rule.match.test(rawMessage)) {
      return {
        message: `${rule.rewrite(rawMessage)}${locator}`.trim(),
        line,
        column,
        raw: rawMessage,
      };
    }
  }

  // Fallback: keep the raw reason but prefix the line locator so the
  // operator at least knows where to look.
  return {
    message: line
      ? `YAML parse error on line ${line}${column ? ` column ${column}` : ''}: ${reason}.`
      : `YAML parse error: ${reason}.`,
    line,
    column,
    raw: rawMessage,
  };
}

