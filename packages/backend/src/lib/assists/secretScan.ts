/**
 * Shared secret-signature scan (#2326 slice 4 + #2146 secret hygiene).
 *
 * ONE source of truth for the known-secret shapes ServiceBay refuses to persist
 * into assist/template content. It is imported by BOTH:
 *
 *   - the BUILD-TIME backstop `tests/backend/assist_consistency.test.ts`, which
 *     fails the suite if a committed `assists/` or `templates/` file matches; and
 *   - the RUNTIME landing gate (`proposals.ts` `approveProposal`), which refuses
 *     to write a `propose_learning` proposal to `DATA_DIR/local-assists/` if its
 *     content matches — so an external `propose`-scoped agent cannot exfiltrate a
 *     secret onto disk via an approved proposal.
 *
 * Because both paths import THIS module, the two scans can never drift: add a
 * signature here and both the committed-file backstop and the runtime landing
 * gate pick it up.
 *
 * High-signal secret formats only — matching concrete leaked values, never
 * `{{VAR}}` placeholders or file paths.
 */

export interface SecretPattern {
  name: string;
  re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'ServiceBay token (sb_)', re: /\bsb_[a-z0-9]{6,}_[A-Za-z0-9]{20,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[posru]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // Authelia stores a cleartext OIDC client secret as `$plaintext$<secret>`
  // (see `extractPlaintextSecret` in the oidc-clients route). A committed one
  // is a real credential every install would share — exactly the #2417 bug,
  // where `templates/auth/configuration.yml.mustache` shipped a literal
  // `client_secret` for the admin panel's own OIDC client on every box in the
  // world and none of the shapes above matched it. (The offending value lives
  // in the regression case in `secretScan.test.ts`, not repeated here.)
  //
  // Deliberately narrow so the legitimate ways of WRITING about one still
  // pass: a Mustache placeholder (`$plaintext${{VAR}}`) and a doc angle-
  // bracket stand-in (`$plaintext$<your-secret>`, used in the immich and
  // vaultwarden READMEs) both start with a character outside the secret
  // alphabet. The 8-char floor keeps short illustrative values in prose
  // (`$plaintext$abc`) from tripping it.
  { name: 'Authelia plaintext OIDC client secret', re: /\$plaintext\$[A-Za-z0-9_-]{8,}/ },
];

/**
 * Scan `text` against every known secret signature. Returns the names of ALL
 * matching signatures (empty array = clean). Returning names, not a boolean,
 * lets callers surface a precise reason ("matches ServiceBay token (sb_)").
 */
export function scanForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}
