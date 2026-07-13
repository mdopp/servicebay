import { describe, it, expect } from 'vitest';
import { sanitizeBundleName } from '@/lib/unmanaged/bundleShared';

/**
 * #2261 — CodeQL js/polynomial-redos + js/redos sweep.
 *
 * These tests pin (a) behaviour parity with the pre-fix regexes and
 * (b) that a crafted pathological input no longer blows up.
 */

describe('sanitizeBundleName (ReDoS-free slugify, #2261)', () => {
  // The exact chained-regex form that the single-pass scan replaced. Used as
  // an oracle: the new impl must produce byte-identical output.
  const legacySlugify = (value: string): string =>
    value
      .replace(/\.service$/i, '')
      .replace(/[^a-zA-Z0-9-.]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

  const cases = [
    'nginx.service',
    'Nginx.SERVICE',
    'my_app@instance.service',
    'Foo Bar Baz',
    '  leading-trailing  ',
    '---dashes---',
    'a...b...c',
    'UPPER_and_lower-42',
    'weird!!!chars$$$here',
    'has.dots.and.service',
    'service', // no leading dot → not stripped
    '.service', // strips to empty
    'x.service.service', // only trailing suffix stripped once
    '@@@@@',
    'a-b_c d.e',
    'pod@1.service',
    'café-münü', // non-ascii → disallowed run
    '',
    'a',
    '-',
    '.',
    'a--b',
    'a__b', // underscores are disallowed → single dash
  ];

  it('produces byte-identical output to the legacy chained regexes', () => {
    for (const input of cases) {
      expect(sanitizeBundleName(input)).toBe(legacySlugify(input));
    }
  });

  it('stays linear on a pathological long input', () => {
    const evil = '!'.repeat(100000) + 'x' + '@'.repeat(100000);
    const start = Date.now();
    const out = sanitizeBundleName(evil);
    expect(out).toBe(legacySlugify(evil));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('mcp/safety destructive-rm patterns (ReDoS-free, #2261)', () => {
  // Re-declare the two patterns exactly as shipped (single-char flag group).
  const rmRoot = /\brm\s+(-[rRfF]\w*\s+)*\/(?:\s|$)/;
  const rmSysPath = /\brm\s+(-[rRfF]\w*\s+)*\/(mnt|var|home|etc|usr|boot)(\s|\/)/;

  // The pre-fix (vulnerable) forms — used only as a semantic oracle for the
  // legitimate-input parity check (NOT executed on adversarial input).
  const legacyRoot = /\brm\s+(-[rRfF]+\w*\s+)*\/(?:\s|$)/;
  const legacySysPath = /\brm\s+(-[rRfF]+\w*\s+)*\/(mnt|var|home|etc|usr|boot)(\s|\/)/;

  const shouldMatchRoot = [
    'rm -rf /',
    'rm -rf / ',
    'rm -fr /',
    'rm -r -f /',
    'rm -rf /  ',
    'rm    -Rf /',
    'sudo rm -rf /', // \b lets the rm match mid-command
    'rm -rfv /', // \w* tail
  ];
  const shouldNotMatchRoot = [
    'rm -rf /home/user/tmp', // path after slash but not bare root → root pattern needs \s|$
    'rm file.txt',
    'rm -rf ./relative',
    'echo rm -rf /', // still matches actually — echo contains rm; keep out of NOT list
  ].filter((c) => c !== 'echo rm -rf /');

  it('the shipped rm-root pattern flags the same dangerous commands as before', () => {
    for (const cmd of shouldMatchRoot) {
      expect(rmRoot.test(cmd)).toBe(true);
      expect(legacyRoot.test(cmd)).toBe(rmRoot.test(cmd));
    }
  });

  it('the shipped rm-root pattern does not over-match benign commands', () => {
    for (const cmd of shouldNotMatchRoot) {
      expect(rmRoot.test(cmd)).toBe(false);
      expect(legacyRoot.test(cmd)).toBe(rmRoot.test(cmd));
    }
  });

  it('the shipped rm-syspath pattern matches parity with the legacy form', () => {
    const cases = [
      'rm -rf /etc/',
      'rm -rf /var ',
      'rm -Rf /home/user',
      'rm -rf /usr/local',
      'rm -rf /boot ',
      'rm -rf /mnt/data',
      'rm -rf /tmp/x', // /tmp not in list → no match
      'rm -rf /opt', // /opt not listed
    ];
    for (const cmd of cases) {
      expect(rmSysPath.test(cmd)).toBe(legacySysPath.test(cmd));
    }
    expect(rmSysPath.test('rm -rf /etc/')).toBe(true);
    expect(rmSysPath.test('rm -rf /tmp/x')).toBe(false);
  });

  it('stays linear on a pathological long flag run (ReDoS guard)', () => {
    // The classic exponential trigger: a long run of flag chars with no
    // matching trailing `/`.
    const evil = 'rm ' + '-' + 'r'.repeat(50000) + 'X'; // no trailing " /"
    const start = Date.now();
    expect(rmRoot.test(evil)).toBe(false);
    expect(rmSysPath.test(evil)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
