/**
 * Secret-redaction helpers for MCP read tools (#321).
 *
 * The read-scope MCP tools `get_service_files` and `get_logs` (the
 * service/container log sources) can otherwise hand back the
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
 * Three passes:
 *
 * 0. **Quadlet / systemd unit form** (#2792) — INI-shaped, not YAML:
 *    `Environment=KEY=VALUE` and `PodmanArgs=… --env KEY=VALUE`. A
 *    `.container`-kind service IS its unit file, so this is the only
 *    shape its secrets ever take and the YAML pass below sees none of it.
 *
 * 1. **Named env-var pairs** — kube YAML form. Match `name: SOMETHING`
 *    followed by `value: X` (across one line or two), where SOMETHING
 *    is secret-shaped per `isSecretEnvName` — our `*_PASSWORD`,
 *    `*_SECRET`, `*_TOKEN`, `*_KEY`, `ACCOUNT_*` convention *plus* the
 *    structural word match `isSecretKey`, which is what catches
 *    `LLDAP_LDAP_USER_PASS` and friends (#2828).
 *
 * 2. **Inline `key: value` patterns** — log form. Match
 *    `password[: =] <value>` and friends. Conservative — only matches
 *    explicit named patterns, not arbitrary 32-char strings (which
 *    would falsely redact UUIDs, container ids, etc.). Plus two
 *    structural passes for the config-file shapes a keyword list can
 *    never enumerate (#2828): a `key: value` **line** whose key name is
 *    secret-shaped (`encryption_key:`), and any PEM private-key block.
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
    if (!isSecretEnvName(name)) return match;
    return `${namePrefix}${name}${valuePrefix}"${REDACTED}"`;
  });

  // JSON object form (single line):
  //   {"name":"FOO_PASSWORD","value":"..."}
  const jsonForm = /("name"\s*:\s*"([A-Z][A-Za-z0-9_]*)"[^}]*?"value"\s*:\s*")([^"]*)(")/g;
  out = out.replace(jsonForm, (match, prefix, name, _value, suffix) => {
    if (!isSecretEnvName(name)) return match;
    return `${prefix}${REDACTED}${suffix}`;
  });

  return out;
}

/**
 * One shell-ish token: a bare run of non-space/non-quote characters, or a
 * quoted run, or any concatenation of those (`KEY="a b"` is ONE token).
 * Used with `.replace()` so the surrounding whitespace is preserved verbatim.
 */
const ASSIGNMENT_TOKEN = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;

/** `FOO_PASSWORD` / `ACCOUNT_samba` / `clientSecret` — the union of the kube
 *  pass's convention regex and the structural word matcher `isSecretKey`
 *  already applies to `get_config` and the MCP audit log. One predicate, so a
 *  name that is secret in YAML is secret in a unit file too (#2792).
 *
 *  Exported since #2833: the journal sink (`lib/log-format.ts`) asks the same
 *  question about an `Environment=NAME=VALUE` assignment on its way to
 *  `console.*`. A private copy of the name list per sink is exactly how this
 *  leak class got reopened five times (#1211 → #2603 → #2616 → #2624 → #2833),
 *  so there is one predicate and every sink imports it. */
export function isSecretEnvName(name: string): boolean {
  return SENSITIVE_NAME.test(name) || isSecretKey(name);
}

/**
 * Redact one `KEY=VALUE` token, preserving whatever quoting it arrived with:
 * `"KEY=v"`, `KEY="v"` and `KEY=v` all keep their shape. Returns the token
 * unchanged when it is not an assignment, when the name is not secret-shaped,
 * or when the value is empty (an empty value carries nothing to leak, and
 * masking it would falsely suggest a secret is set).
 */
function redactAssignmentToken(token: string): string {
  const outerQuote = token.length >= 2 && (token[0] === '"' || token[0] === "'") && token.at(-1) === token[0]
    ? token[0]
    : '';
  const inner = outerQuote ? token.slice(1, -1) : token;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(inner);
  if (!m) return token;
  const [, name, rawValue] = m;
  if (!isSecretEnvName(name) || rawValue === '') return token;
  const valueQuote = rawValue.length >= 2
    && (rawValue[0] === '"' || rawValue[0] === "'")
    && rawValue.at(-1) === rawValue[0]
    ? rawValue[0]
    : '';
  return `${outerQuote}${name}=${valueQuote}${REDACTED}${valueQuote}${outerQuote}`;
}

/**
 * Redact secrets in a systemd/Quadlet unit body (#2792).
 *
 * A `.container`-kind service has no pod spec — the unit file *is* the
 * artifact, so `get_service_files` hands back the `[Container]` section with
 * its `Environment=` lines inline. `redactKubeYaml` only understands the YAML
 * `name:`/`value:` shape, so those lines went out in plaintext.
 *
 *   Environment=SERVICEBAY_PASSWORD=hunter2   → Environment=SERVICEBAY_PASSWORD=<redacted>
 *   Environment="SB_TOKEN=a b" TZ=Europe/Berlin
 *                                            → Environment="SB_TOKEN=<redacted>" TZ=Europe/Berlin
 *   PodmanArgs=--env API_KEY=abc --label a=b  → PodmanArgs=--env API_KEY=<redacted> --label a=b
 *
 * Deliberately NOT redacted: a Quadlet `Secret=<name>[,opt=…]` line, whose
 * payload is a *reference* to a podman secret, never a literal — the value
 * lives in podman's secret store and is not in the file. Masking the reference
 * would only cost an operator the ability to see which secret is wired up (and
 * would break the `get_service_files` → `update_service_yaml` round-trip for a
 * field that leaks nothing).
 *
 * Safe to run over kube YAML as well: YAML carries no `Environment=` directive
 * and no bare `--env KEY=VALUE`, so the pass is a no-op there.
 */
export function redactQuadletUnit(text: string): string {
  if (!text) return text;

  return text
    .split('\n')
    .map(line => {
      // `Environment=` (systemd allows several assignments per line, quoted
      // or not). Match the directive only at the head of the line so a value
      // that merely mentions the word is left alone.
      let out = line.replace(
        /^([ \t]*Environment[ \t]*=)(.*)$/i,
        (_m, prefix: string, rest: string) =>
          prefix + rest.replace(ASSIGNMENT_TOKEN, redactAssignmentToken),
      );
      // `--env KEY=V`, `--env=KEY=V`, `-e KEY=V` — as passed through
      // `PodmanArgs=` or `Exec=`. `--env-file=` does not match (no `=`/space
      // straight after `--env`), and it names a path, not a value.
      out = out.replace(
        /(--env[=\s]+|(?:^|\s)-e\s+)((?:[^\s"']+|"[^"]*"|'[^']*')+)/g,
        (_m, prefix: string, token: string) => prefix + redactAssignmentToken(token),
      );
      return out;
    })
    .join('\n');
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
 *
 * The keyword list alone under-redacts a *config file* read through
 * `read_file` (#2828): `storage.encryption_key:` carries no listed keyword,
 * and a PEM private key carries no key/value shape at all. So two structural
 * passes back it up — `redactPemPrivateKeys` (any `-----BEGIN … PRIVATE
 * KEY-----` block) and `redactSecretKeyLines` (a `name: value` / `name=value`
 * line whose *name* is secret-shaped per `isSecretKey`, the same predicate
 * `get_config` and the audit log already use).
 */
export function redactLogText(text: string): string {
  if (!text) return text;

  const KEYWORDS = '(?:password|passwd|secret|token|api[_-]?key)';

  let out = text;

  // PEM private-key blocks FIRST (#2828): the body is base64, so no other
  // pass recognises it, and running first keeps those passes off it.
  out = redactPemPrivateKeys(out);

  // Multi-line YAML block scalar (#581):
  //   password: |
  //     line1
  //     line2
  // Run this first — operates line-by-line so it doesn't trip over the
  // single-line patterns below. The continuation lines are any lines
  // indented MORE than the key line; the block ends at the next line
  // with same-or-less indent (or EOF).
  out = redactYamlBlockScalars(out);

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

  // Structural key/value lines LAST (#2828) — it skips a value the keyword
  // passes above already masked, so the two never fight over one line.
  out = redactSecretKeyLines(out);

  return out;
}

const PEM_PRIVATE_BEGIN = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----';
const PEM_PRIVATE_END = '-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----';

/** A line that is nothing but a PEM private-key BEGIN/END marker. The markers
 *  carry no key material — `redactPemPrivateKeys` preserves them on purpose —
 *  so any later pass walking the same lines must leave them alone (#2838). */
const PEM_PRIVATE_MARKER_LINE = new RegExp(
  `^[ \\t]*(?:${PEM_PRIVATE_BEGIN}|${PEM_PRIVATE_END})[ \\t]*$`,
);

/**
 * Mask the body of every PEM **private**-key block (#2828).
 *
 * Authelia's `identity_providers.oidc.jwks[].key` is an inline PEM block: no
 * `password`-ish keyword anywhere, so every keyword pass walks straight past
 * it and `read_file` handed the whole private key back in plaintext.
 *
 * Deliberately private-key only: `-----BEGIN CERTIFICATE-----` and
 * `-----BEGIN PUBLIC KEY-----` are meant to be readable, and masking them
 * would cost an operator the ability to check which cert is wired up while
 * leaking nothing.
 *
 * An **unterminated** block (a truncated log, a clipped file) is masked to the
 * end of the text — a key that lost its `-----END …-----` is still a key, so
 * this fails closed.
 */
function redactPemPrivateKeys(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text;
  const label = PEM_PRIVATE_BEGIN;
  const end = PEM_PRIVATE_END;
  let out = text.replace(
    new RegExp(`^([ \\t]*)(${label})[\\s\\S]*?^[ \\t]*(${end})`, 'gm'),
    (_m, indent: string, begin: string, terminator: string) =>
      `${indent}${begin}\n${indent}${REDACTED}\n${indent}${terminator}`,
  );
  // Unterminated: a BEGIN with no END *after* it (the lookahead is what keeps
  // this off a block the pass above already masked).
  out = out.replace(
    new RegExp(`^([ \\t]*)(${label})(?![\\s\\S]*${end})[\\s\\S]*$`, 'm'),
    (_m, indent: string, begin: string) => `${indent}${begin}\n${indent}${REDACTED}`,
  );
  return out;
}

/**
 * A `name: value` / `name=value` **line** whose name is secret-shaped (#2828).
 *
 * The keyword list is an enumeration, so it only ever covers the names someone
 * remembered — `encryption_key` was not one of them. This pass asks the
 * structural question instead: is the *key name* secret-shaped per
 * `isSecretKey` (the predicate `get_config` and the MCP audit log already
 * share)? One predicate, so a name that is secret in the config is secret in a
 * file read too.
 *
 * Anchored to the start of the line (with an optional YAML list marker) on
 * purpose: that is the config-file shape this closes, and mid-line matching
 * would turn every log sentence containing " key: " into `<redacted>`. The
 * keyword passes still cover the mid-line log shapes they always did.
 */
const SECRET_KEY_LINE = /^([ \t]*(?:-[ \t]+)?)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2([ \t]*[:=][ \t]*)(.+)$/;

function redactSecretKeyLines(text: string): string {
  if (!text.includes(':') && !text.includes('=')) return text;
  return text
    .split('\n')
    .map(line => {
      const match = SECRET_KEY_LINE.exec(line);
      if (!match) return line;
      const [, indent, quote, name, separator, value] = match;
      if (!isSecretKey(name)) return line;
      const masked = maskScalarValue(value);
      return masked === null ? line : `${indent}${quote}${name}${quote}${separator}${masked}`;
    })
    .join('\n');
}

/**
 * Mask one scalar value, keeping its quoting and a trailing JSON comma so the
 * surrounding document still reads. Returns `null` — leave the line alone —
 * for anything that carries no secret: an empty value, a value already masked,
 * an empty/null placeholder, and a YAML block-scalar header (`key: |`), whose
 * body `redactYamlBlockScalars` has already masked.
 */
function maskScalarValue(value: string): string | null {
  const match = /^(["'`]?)([\s\S]*?)\1([ \t]*,?)$/.exec(value);
  if (!match) return null;
  const [, quote, body, tail] = match;
  const trimmed = body.trim();
  if (trimmed === '' || trimmed === REDACTED) return null;
  if (/^[|>][+-]?$/.test(trimmed)) return null;
  if (trimmed === '{}' || trimmed === '[]' || trimmed === 'null' || trimmed === '~') return null;
  return `${quote}${REDACTED}${quote}${tail}`;
}

/**
 * Walk `text` line by line and replace YAML block-scalar bodies whose key is
 * secret-shaped (anchored to a `|` or `>` scalar header). Stops the block at
 * the next line with same-or-less indent than the key line. Conservative: only
 * redacts the block body, never the structural lines around it.
 *
 * The key test is `isSecretKey`, not a keyword list (#2828) — it covers every
 * keyword the list held (`password`, `secret`, `token`, `api_key`, …) and also
 * the ones it did not (`key: |`, the shape Authelia's inline OIDC private key
 * arrives in).
 */
function redactYamlBlockScalars(text: string): string {
  const lines = text.split('\n');
  const headerRe = /^([ \t]*(?:-[ \t]+)?)(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2\s*:\s*[|>][+-]?\s*$/;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(headerRe);
    if (!m || !isSecretKey(m[3])) {
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
      // Leave the lines that carry nothing (#2838): `redactPemPrivateKeys`
      // runs first in `redactLogText` and has already collapsed any PEM body
      // to a single `<redacted>` line while deliberately keeping its
      // `-----BEGIN/END … PRIVATE KEY-----` markers. Re-masking those here
      // swallowed the markers whenever the block's own key name was
      // secret-shaped (`key: |` — Authelia's real OIDC JWK shape), so the
      // operator could no longer tell a private key from any other blob.
      if (PEM_PRIVATE_MARKER_LINE.test(cont) || cont.trim() === REDACTED) {
        out.push(cont);
        i++;
        continue;
      }
      out.push(' '.repeat(contIndent) + REDACTED);
      i++;
    }
  }
  return out.join('\n');
}

/**
 * Secret-shaped key names (#2404, shared here by #2624).
 *
 * `sanitizeConfig` used to be a three-field denylist while `AppConfig`'s whole
 * job includes storing dozens of per-service credentials. A path denylist is
 * the wrong shape: it can only ever cover the fields someone remembered, and
 * new secret-bearing fields arrive per-service. So the match is on the *key
 * name*, structurally, at every depth.
 *
 * Matching is word-based (`clientSecret` → `client` + `secret`,
 * `LLDAP_ADMIN_PASSWORD` → `lldap` + `admin` + `password`) rather than raw
 * substring, because the config is full of maps keyed by *service name* —
 * `installedTemplates`, `servicePostDeploy`, `serviceMigrations`,
 * `templateSettings` — and a raw substring match would redact a service called
 * `keycloak` or `passbolt`. Over-redacting a real field is a bug too, just a
 * far cheaper one than under-redacting, so the tie-breaks below lean redact.
 *
 * It lives in this module rather than next to one of its callers because it
 * has three now — `get_config`'s sanitiser, the MCP audit log's arg redactor
 * (#2624), and anything that follows. A per-caller copy is exactly how the
 * same leak got reopened three times (#1211 → #2603 → #2616 → #2624).
 */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pass', 'passphrase',
  'secret', 'token', 'key', 'apikey', 'privatekey',
  'credential', 'hash', 'salt', 'bearer',
]);

/**
 * Run-together lowercase names never split into words (`apikey`,
 * `clientsecret`, `accesstoken`, `privatekey`), so they get a suffix match on
 * the de-punctuated key as well. Suffix-only, and deliberately without `pass`:
 * a prefix match would catch `keycloak`, and a `pass` suffix would catch
 * `bypass`.
 */
const SECRET_SUFFIXES = [
  'password', 'passphrase', 'secret', 'token', 'key', 'credential', 'hash', 'salt',
];

/** `LLDAP_ADMIN_PASSWORD` / `clientSecret` / `api-key` → lowercase words. */
const splitKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map(word => word.toLowerCase())
    .filter(Boolean);

/**
 * Does this key name look like it holds a secret? Exported for the test
 * suites, which pin both the positives and the service-name negatives.
 */
export function isSecretKey(key: string): boolean {
  const words = splitKeyWords(key);
  const secretWords = words.filter(isSecretWord);
  if (secretWords.length > 0 && !isKeyIdentifierName(words, secretWords)) return true;
  const flat = words.join('');
  return SECRET_SUFFIXES.some(suffix => flat.endsWith(suffix) || flat.endsWith(`${suffix}s`));
}

/** One word of a key name, secret-shaped? Plurals count: `installedSecrets` →
 *  `secrets`, `apiKeys` → `keys`. */
const isSecretWord = (word: string): boolean =>
  SECRET_WORDS.has(word) || (word.endsWith('s') && SECRET_WORDS.has(word.slice(0, -1)));

/**
 * `key_id` / `keyId` / `key_ids` — an identifier that *references* a key, not
 * the key itself (#2838). Authelia's `identity_providers.oidc.jwks[].key_id`
 * is the JWK's public `kid`; masking it costs the operator the ability to see
 * which key is wired up and hides nothing (the `key:` beside it still masks).
 *
 * Narrow on purpose: the exemption applies only when `key` is the ONLY
 * secret-shaped word in the name, so a name where the identifier IS the
 * credential — Vault AppRole's `secret_id`, a `password_id`, a `token_id` —
 * stays masked. The tie-break still leans redact everywhere else.
 */
function isKeyIdentifierName(words: string[], secretWords: string[]): boolean {
  const last = words.at(-1);
  if (last !== 'id' && last !== 'ids') return false;
  return secretWords.every(word => word === 'key' || word === 'keys');
}

/** Redact a `getServiceFiles` payload — touches yamlContent +
 *  serviceContent (which can echo the env-vars too via systemctl
 *  cat output), plus the rendered kube file. Path fields stay as-is.
 *
 *  Every field gets BOTH passes, because which one carries the secret depends
 *  on the service's quadlet kind: a `.kube` service puts its env in the YAML
 *  pod spec (`yamlContent`), while a `.container` service has no pod spec at
 *  all and puts it in the unit body (`kubeContent`) as `Environment=` lines
 *  (#2792). `serviceContent` is generator/`systemctl cat` output — unit-shaped
 *  either way. Each pass is a no-op on the shape it does not own. */
export function redactServiceFiles<T extends {
  kubeContent?: string;
  yamlContent?: string;
  serviceContent?: string;
}>(files: T): T {
  const redact = (text: string): string => redactQuadletUnit(redactKubeYaml(text));
  return {
    ...files,
    kubeContent: redact(files.kubeContent ?? ''),
    yamlContent: redact(files.yamlContent ?? ''),
    serviceContent: redact(files.serviceContent ?? ''),
  };
}

/**
 * Redact the parsed env-var maps an unmanaged-bundle scan carries (#2792).
 *
 * `get_unmanaged_bundles` reads legacy compose/systemd units off the box and
 * hands back `serviceTemplates[].environment` — a `Record<name, value>` of the
 * values it found, i.e. the same secrets in a different container. Everything
 * else on a bundle is shape (ids, images, ports, paths), so this is the only
 * field that needs masking. Same name predicate as the unit pass, so a name
 * that is secret in a `.container` file is secret here too.
 */
export function redactBundleEnvironments<T extends {
  serviceTemplates?: { environment?: Record<string, string> }[];
}>(bundles: T[]): T[] {
  return bundles.map(bundle => {
    if (!bundle.serviceTemplates?.length) return bundle;
    return {
      ...bundle,
      serviceTemplates: bundle.serviceTemplates.map(template => {
        if (!template.environment) return template;
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(template.environment)) {
          environment[name] = isSecretEnvName(name) && value !== '' ? REDACTED : value;
        }
        return { ...template, environment };
      }),
    };
  });
}
