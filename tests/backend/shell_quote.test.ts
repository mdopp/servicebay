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
});
