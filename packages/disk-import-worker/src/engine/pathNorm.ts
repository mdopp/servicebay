// Shared, backtracking-free path normalisation (#2255).
//
// CodeQL flags chained path-normalisation regexes (`.replace(/^\/+/,'')` etc.)
// as `js/polynomial-redos` — a `+`-quantified slash run on attacker-influenced
// input can be driven quadratic. These helpers do the SAME normalisation with
// pure character scanning (no regex, no backtracking), so behaviour is identical
// but there is no ReDoS surface. One shared impl reused across every site so the
// four normalisations can't drift.
//
// Behaviour, made explicit (must match the regex forms it replaces EXACTLY):
//   - backslashes → forward slashes  (opt-in via `backslashToSlash`)
//   - leading slash run stripped     (opt-in via `stripLeading`, default true)
//   - trailing slash run stripped    (always)
//   - INTERNAL slashes are preserved verbatim (the old regexes only touched the
//     leading/trailing runs — `a//b` stays `a//b`).

export interface NormPathOptions {
  /** Convert `\` → `/` first (Windows-style separators). Default false. */
  backslashToSlash?: boolean;
  /** Strip the leading slash run. Default true; set false to keep a leading `/`. */
  stripLeading?: boolean;
}

/** Replace every `\` with `/` without a regex (no backtracking). */
function backslashesToSlashes(input: string): string {
  return input.indexOf('\\') === -1 ? input : input.split('\\').join('/');
}

/**
 * Normalise a slash-delimited path with pure scanning — the safe replacement for
 * the chained `.replace(/\\/g,'/').replace(/^\/+/,'').replace(/\/+$/,'')` forms.
 */
export function normPath(input: string, options: NormPathOptions = {}): string {
  const { backslashToSlash = false, stripLeading = true } = options;
  const s = backslashToSlash ? backslashesToSlashes(input) : input;

  let start = 0;
  let end = s.length;
  if (stripLeading) {
    while (start < end && s.charCodeAt(start) === 47 /* '/' */) start += 1;
  }
  while (end > start && s.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}
