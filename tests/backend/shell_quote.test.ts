import { describe, it, expect } from 'vitest';
import { shellQuote, shellQuoteAll } from '@/lib/util/shellQuote';

describe('shellQuote', () => {
  it('passes through safe identifiers unchanged', () => {
    expect(shellQuote('nginx')).toBe('nginx');
    expect(shellQuote('foo.bar_baz-1')).toBe('foo.bar_baz-1');
    expect(shellQuote('/usr/local/bin/cmd')).toBe('/usr/local/bin/cmd');
  });

  it('quotes empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('escapes shell metacharacters', () => {
    expect(shellQuote('a;b')).toBe("'a;b'");
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
    expect(shellQuote('`whoami`')).toBe("'`whoami`'");
    expect(shellQuote('a|b')).toBe("'a|b'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });

  it('shellQuoteAll concatenates with spaces', () => {
    expect(shellQuoteAll(['ping', '-c', '1', '1.1.1.1; ls'])).toBe(`ping -c 1 '1.1.1.1; ls'`);
  });

  // POSIX edge cases (#1087). The contract: every value, no matter how
  // weird, becomes a single shell token whose value, when expanded by the
  // shell, is byte-for-byte identical to the input. Single-quoting is the
  // only POSIX escape that suppresses ALL expansion ($, `, \, !, history,
  // glob), so we lean on it for anything not in the safe-char allowlist.

  it('preserves newlines literally inside single quotes', () => {
    expect(shellQuote('a\nb')).toBe("'a\nb'");
    expect(shellQuote('line1\nline2\n')).toBe("'line1\nline2\n'");
  });

  it('preserves tabs and carriage returns literally', () => {
    expect(shellQuote('a\tb')).toBe("'a\tb'");
    expect(shellQuote('a\rb')).toBe("'a\rb'");
  });

  it('escapes backticks nested inside $(...)', () => {
    // Single quotes block both layers of expansion at once, so the
    // classic "thought I escaped it but $() re-parses" bug cannot occur.
    expect(shellQuote('$(`whoami`)')).toBe("'$(`whoami`)'");
    expect(shellQuote('$(echo `id`)')).toBe("'$(echo `id`)'");
  });

  it('escapes history-expansion bang', () => {
    expect(shellQuote('!sudo')).toBe("'!sudo'");
    expect(shellQuote('foo!bar')).toBe("'foo!bar'");
  });

  it('escapes glob metacharacters', () => {
    expect(shellQuote('*.sh')).toBe("'*.sh'");
    expect(shellQuote('?ile')).toBe("'?ile'");
    expect(shellQuote('[abc]')).toBe("'[abc]'");
    expect(shellQuote('{a,b}')).toBe("'{a,b}'");
  });

  it('escapes redirection and process-substitution metacharacters', () => {
    expect(shellQuote('a>b')).toBe("'a>b'");
    expect(shellQuote('a<b')).toBe("'a<b'");
    expect(shellQuote('<(cat /etc/shadow)')).toBe("'<(cat /etc/shadow)'");
    expect(shellQuote('a&b')).toBe("'a&b'");
    expect(shellQuote('a&&b')).toBe("'a&&b'");
  });

  it('passes leading hyphen through unquoted — argv-parsing is the caller s problem', () => {
    // Hyphen is in the safe-char allowlist because every flag uses it.
    // shellQuote is a *shell-quoting* primitive, not an argv-parsing one:
    // a value of `-rf` will be interpreted as a flag by the receiving
    // program whether or not it was single-quoted, because the shell has
    // already split argv before the program sees it. Callers handling
    // untrusted input MUST use the `--` separator (`rm -- "$arg"`) or
    // `execFile(['cmd', '--', arg])`. Test pins the current behaviour so
    // any future change is intentional.
    expect(shellQuote('-rf')).toBe('-rf');
    expect(shellQuote('-')).toBe('-');
    expect(shellQuote('--help')).toBe('--help');
  });

  it('quotes NUL byte rather than truncating the value', () => {
    // Most POSIX shells truncate argv at NUL because argv is a C string.
    // shellQuote can't prevent that — it only guarantees the *string* it
    // emits is single-quoted. Pin the behaviour: NUL goes inside the
    // single quotes verbatim; what the receiving shell does with it is
    // outside this primitive's contract.
    expect(shellQuote('a\0b')).toBe("'a\0b'");
    expect(shellQuote('\0')).toBe("'\0'");
  });

  it('quotes a value that is itself a single quote', () => {
    expect(shellQuote("'")).toBe(`''\\'''`);
  });

  it('keeps the escape sequence intact next to other quoted content', () => {
    expect(shellQuote(`foo'$bar`)).toBe(`'foo'\\''$bar'`);
    expect(shellQuote(`a'b'c`)).toBe(`'a'\\''b'\\''c'`);
  });

  it('shellQuoteAll on empty argv returns empty string', () => {
    expect(shellQuoteAll([])).toBe('');
  });

  it('shellQuoteAll preserves order and handles mixed safe/unsafe args', () => {
    expect(shellQuoteAll(['ssh', 'user@host', '--', 'rm -rf /'])).toBe(
      `ssh user@host -- 'rm -rf /'`,
    );
  });
});
