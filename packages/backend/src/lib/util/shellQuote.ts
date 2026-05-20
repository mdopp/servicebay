/**
 * Quote an argv element for safe inclusion in a POSIX shell command line.
 * The result is always single-quoted. Every embedded single quote is closed,
 * escaped, and reopened. Empty strings become `''`.
 *
 * Use this when an argv must be flattened into a single command string —
 * for example before sending it to the agent via `exec` over SSH. Never
 * concatenate user input into shell commands without going through here.
 */
export function shellQuote(arg: string): string {
  if (arg.length === 0) return "''";
  // If the value is purely safe characters, no quoting needed.
  if (/^[A-Za-z0-9_+,./:=@%-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellQuoteAll(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}
