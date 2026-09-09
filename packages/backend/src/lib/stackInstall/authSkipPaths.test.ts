import { describe, it, expect } from 'vitest';
import {
  AUTHELIA_FORWARD_AUTH_SENTINEL,
  renderForwardAuthAdvancedConfig,
} from './forwardAuth';
import {
  analyzeForwardAuthConfig,
  hostWideBypasses,
  isNpmOwnedAcmePrefix,
  normalizePrefixSegments,
  resolveAuthForPath,
  validateAuthSkipPath,
} from './authSkipPaths';

/**
 * #2932 — the CLASS GATE for `authSkipPaths`.
 *
 * The point of this file is the property test at the bottom: it asserts the
 * invariant on the RENDERED nginx text, over a generated corpus of hostile
 * and benign entries, not on the input and not on a single `"/"` case. A
 * test that only checks "`/` is refused" would pass against a validator
 * that special-cases the string `"/"` and still lets `//`, `/a/..`,
 * `/x } location / { auth_request off; }` and friends through.
 */

const PORT = '9091';

/** Render exactly what a public/internal (LE) host gets. */
function render(authSkipPaths: string[]): string {
  return renderForwardAuthAdvancedConfig(AUTHELIA_FORWARD_AUTH_SENTINEL, PORT, {
    omitAcmeBypass: true,
    authSkipPaths,
  })!;
}

// ─── The corpus ────────────────────────────────────────────────────────────

/** Entries that must never reach the rendered config. Each one is a real
 *  way to turn the host-wide gate off or to leave the location block. */
const HOSTILE: string[] = [
  '/',
  ' / ',
  '//',
  '///',
  '/.',
  '/./',
  '/..',
  '/a/..',
  '/a/../..',
  '/./././',
  // Block escape: close our location, open an ungated one for everything.
  '/x } location / { auth_request off; include conf.d/include/proxy.conf; } location /y {',
  '/x }',
  '/x;auth_request off;',
  '/x\n}\nauth_request off;',
  '/x{',
  '/x#\nauth_request off;',
  '/x$uri',
  '/x"y"',
  "/x'y'",
  '/x\\y',
  '/x y',
  '/x\ty',
  '/x*',
  '/x\r\n}',
  // Not absolute at all.
  'static',
  '',
  '   ',
  '^~ /',
  '~ .*',
  // Over-long.
  `/${'a'.repeat(400)}`,
];

/** Entries that must be rendered and must genuinely turn auth off for
 *  themselves — otherwise a validator could pass this gate by refusing
 *  everything. */
const BENIGN: string[] = [
  '/static/',
  '/static',
  '/assets/img',
  '/.well-known/',
  '/.well-known/assetlinks.json',
  '/api/v1/public',
  '/~user/',
  '/a-b_c.d',
  '/media/@public',
  '/x%20y',
  '/v2/tokens:refresh',
  '/a+b',
];

/** NPM owns this prefix; the renderer drops it rather than duplicating it. */
const ACME = ['/.well-known/acme-challenge/', '/.well-known/acme-challenge'];

/** Deterministic LCG — a generated corpus that is identical on every run,
 *  so a red here is reproducible rather than a flake. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FUZZ_CHARS = [
  ...'abcXYZ019', '/', '.', '-', '_', '~', '%', '@', ':', '+',
  '{', '}', ';', '#', '$', '"', "'", '\\', ' ', '\t', '\n', '*', '^', '?',
];

/** Random entries drawn from a pool that deliberately includes every
 *  metacharacter of the `location ^~ <entry> {` line. */
function fuzzEntries(count: number): string[] {
  const rng = makeRng(0x2932);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rng() * 14);
    let s = rng() < 0.8 ? '/' : '';
    for (let k = 0; k < len; k++) s += FUZZ_CHARS[Math.floor(rng() * FUZZ_CHARS.length)];
    out.push(s);
  }
  return out;
}

/** Group the corpus into the input arrays the renderer actually receives:
 *  singletons plus mixed hostile/benign combinations. */
function corpusInputs(): string[][] {
  const singles = [...HOSTILE, ...BENIGN, ...ACME, ...fuzzEntries(400)].map(e => [e]);
  const mixed: string[][] = [];
  for (let i = 0; i < HOSTILE.length; i++) {
    mixed.push([BENIGN[i % BENIGN.length], HOSTILE[i], BENIGN[(i + 1) % BENIGN.length]]);
    mixed.push([HOSTILE[i], ACME[i % ACME.length]]);
  }
  return [...singles, ...mixed];
}

/** A path no accepted entry covers — the "at least one path outside the
 *  declared exemptions" the invariant is stated over. */
function probeOutsideSkips(accepted: string[]): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = `/zzsbprobe${i}/deep/page`;
    if (!accepted.some(p => candidate.startsWith(p))) return candidate;
  }
  throw new Error('could not find a path outside the declared skips');
}

// ─── The invariant ─────────────────────────────────────────────────────────

describe('#2932 class gate — the RENDERED config still gates everything outside the declared skips', () => {
  const inputs = corpusInputs();

  it('covers a corpus of hostile and benign entries, not a single root case', () => {
    // Guards the guard: if someone trims the corpus down to "/", this fails.
    expect(inputs.length).toBeGreaterThan(400);
    expect(inputs.some(i => i.some(e => e.includes('}')))).toBe(true);
    expect(inputs.some(i => i.some(e => validateAuthSkipPath(e).ok))).toBe(true);
  });

  it.each(inputs.map((entries, i) => [i, entries] as const))(
    'input #%i keeps the host gated and the blocks balanced',
    (_i, entries) => {
      const out = render(entries);
      const analysis = analyzeForwardAuthConfig(out);

      // (a) Nothing escaped its block.
      expect(analysis.balanced).toBe(true);
      // (b) The inherited server-level gate is still there.
      expect(analysis.serverAuthRequest).toBe(true);
      // (c) No location switches auth off for the whole host.
      expect(hostWideBypasses(analysis)).toEqual([]);

      const accepted = entries
        .map(e => validateAuthSkipPath(e))
        .filter((v): v is { ok: true; path: string } => v.ok)
        .map(v => v.path);

      // (d) A path outside every declared skip is STILL behind Authelia.
      expect(resolveAuthForPath(analysis, probeOutsideSkips(accepted))).toBe(true);

      // (e) …and the gate is not passing by refusing everything: each
      //     accepted, non-ACME entry really is exempted in the output.
      for (const path of accepted) {
        if (isNpmOwnedAcmePrefix(path)) continue;
        expect(out).toContain(`location ^~ ${path} {`);
        expect(resolveAuthForPath(analysis, path)).toBe(false);
      }

      // (f) A refused entry is rendered nowhere, and an entry carrying
      //     nginx syntax leaves no trace of that payload at all.
      for (const raw of entries) {
        if (validateAuthSkipPath(raw).ok) continue;
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        expect(out).not.toContain(`location ^~ ${trimmed} {`);
        // Short fuzz strings like "/$" occur incidentally inside the snippet
        // (`//$http_host`), so the payload check needs a distinctive length.
        if (trimmed.length >= 8 && /[{};#\n\r$"'\\]/.test(trimmed)) expect(out).not.toContain(trimmed);
      }
    },
  );

  it('the invariant is not vacuous — the pre-fix rendering fails it', () => {
    // What `buildAuthSkipLocations` produced for `["/"]` before #2932.
    const vulnerable = `${render(['/static/'])}\n\nlocation ^~ / {\n    auth_request off;\n    include conf.d/include/proxy.conf;\n}`;
    const analysis = analyzeForwardAuthConfig(vulnerable);
    expect(analysis.serverAuthRequest).toBe(true); // still "looks" gated
    expect(hostWideBypasses(analysis)).toEqual(['/']);
    expect(resolveAuthForPath(analysis, '/zzsbprobe0/deep/page')).toBe(false);
  });

  it('an escaped block is detected as unbalanced', () => {
    const escaped = 'auth_request /authelia;\nlocation ^~ /x } location / { auth_request off; {\n}';
    expect(analyzeForwardAuthConfig(escaped).balanced).toBe(false);
  });
});

// ─── The validator itself ──────────────────────────────────────────────────

describe('validateAuthSkipPath (#2932)', () => {
  it('refuses every entry that covers the whole host', () => {
    for (const p of ['/', '//', '///', '/.', '/./', '/..', '/a/..', '/a/../..', ' / ']) {
      const v = validateAuthSkipPath(p);
      expect(v.ok, `${JSON.stringify(p)} must be refused`).toBe(false);
      if (!v.ok) expect(v.reason).toContain('covers the whole host');
    }
  });

  it('refuses anything that can terminate or re-shape the location line', () => {
    for (const p of ['/x}', '/x{', '/x;y', '/x y', '/x\n}', '/x#c', '/x$uri', '/x"y"', "/x'y'", '/x\\y', '/x*']) {
      expect(validateAuthSkipPath(p).ok, `${JSON.stringify(p)} must be refused`).toBe(false);
    }
  });

  it('refuses a non-absolute or over-long entry', () => {
    expect(validateAuthSkipPath('static/').ok).toBe(false);
    expect(validateAuthSkipPath('').ok).toBe(false);
    expect(validateAuthSkipPath(`/${'a'.repeat(400)}`).ok).toBe(false);
  });

  it('accepts the real-world skip prefixes and returns them trimmed', () => {
    for (const p of BENIGN) {
      const v = validateAuthSkipPath(`  ${p}  `);
      expect(v.ok, `${JSON.stringify(p)} must be accepted`).toBe(true);
      if (v.ok) expect(v.path).toBe(p);
    }
  });

  it('normalizes a prefix down to the segments it actually constrains', () => {
    expect(normalizePrefixSegments('/static/')).toEqual(['static']);
    expect(normalizePrefixSegments('/a/./b')).toEqual(['a', 'b']);
    expect(normalizePrefixSegments('/a/../b')).toEqual(['b']);
    expect(normalizePrefixSegments('//')).toEqual([]);
  });
});

// ─── The renderer's independent refusal ────────────────────────────────────

describe('buildAuthSkipLocations refuses independently of the MCP schema (#2932)', () => {
  it('drops a host-wide entry that reached the renderer without the tool', () => {
    const out = render(['/']);
    expect(out).not.toContain('location ^~ / {');
    expect(resolveAuthForPath(analyzeForwardAuthConfig(out), '/anything')).toBe(true);
  });

  it('drops an escape attempt and keeps the config balanced', () => {
    const out = render(['/ok/', '/x } location / { auth_request off; }']);
    expect(out).toContain('location ^~ /ok/ {');
    expect(out).not.toContain('location / {');
    expect(analyzeForwardAuthConfig(out).balanced).toBe(true);
  });

  it('still drops NPM\'s acme-challenge prefix (pre-existing behaviour)', () => {
    expect(render(['/.well-known/acme-challenge/'])).not.toContain('acme-challenge');
  });
});
