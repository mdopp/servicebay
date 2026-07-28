/**
 * `SECRET_PATTERNS` is the shared signature list behind BOTH the build-time
 * backstop (`tests/backend/assist_consistency.test.ts`, which walks `assists/`
 * and `templates/`) and the runtime landing gate for approved learning
 * proposals. A signature that silently stops matching disarms both at once, so
 * the shapes get their own direct tests.
 *
 * The plaintext-OIDC shape is the #2417 addition: none of the previous shapes
 * (PEM / `sb_` / AKIA / `gh_` / `xox`) matched
 * `client_secret: '$plaintext$servicebay-oidc-secret'`, so the auth template
 * shipped a real, world-shared credential past a green suite for months.
 */
import { describe, it, expect } from 'vitest';
import { scanForSecrets, SECRET_PATTERNS } from './secretScan';

const OIDC = 'Authelia plaintext OIDC client secret';

describe('SECRET_PATTERNS — Authelia plaintext OIDC client secret (#2417)', () => {
  it('is registered', () => {
    expect(SECRET_PATTERNS.map(p => p.name)).toContain(OIDC);
  });

  it('catches the exact literal the auth template used to ship', () => {
    // The regression this shape exists for, verbatim from
    // configuration.yml.mustache before the fix.
    const line = "        client_secret: '$plaintext$servicebay-oidc-secret'";
    expect(scanForSecrets(line)).toContain(OIDC);
  });

  it('catches a generated-looking secret pasted into a committed file', () => {
    expect(scanForSecrets("client_secret: '$plaintext$Xk29fQpL0aZmR4tYvB7nHc3sWd1eGjU5'")).toContain(OIDC);
  });

  it('catches it anywhere, not only on a client_secret line', () => {
    expect(scanForSecrets('the box is using $plaintext$aVeryRealSecretValue right now')).toContain(OIDC);
  });

  // The false-positive guards. Each of these is a real committed string today;
  // flagging one would make the backstop unusable and invite an exemption.
  it('does NOT flag the Mustache placeholder that replaced the literal', () => {
    const fixed = "        client_secret: '$plaintext${{SERVICEBAY_OIDC_SECRET}}'";
    expect(scanForSecrets(fixed)).not.toContain(OIDC);
  });

  it('does NOT flag the angle-bracket stand-in used in template READMEs', () => {
    // templates/immich/README.md and templates/vaultwarden/README.md.
    expect(scanForSecrets("        client_secret: '$plaintext$<your-secret>'")).not.toContain(OIDC);
  });

  it('does NOT flag a short illustrative value in prose', () => {
    expect(scanForSecrets('e.g. `$plaintext$abc`')).not.toContain(OIDC);
  });

  it('does NOT flag a HASHED secret — those are safe to commit by construction', () => {
    expect(scanForSecrets("client_secret: '$pbkdf2-sha512$310000$abcdefghij$klmnopqrst'")).not.toContain(OIDC);
    expect(scanForSecrets("client_secret: '$argon2id$v=19$m=65536,t=3,p=4$abcdefghij$klmnop'")).not.toContain(OIDC);
  });

  it('leaves clean text clean', () => {
    expect(scanForSecrets('Authelia stores cleartext client secrets with a $plaintext$ prefix.')).toEqual([]);
  });
});
