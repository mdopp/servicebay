import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Maintenance-script hygiene (#2463, #2464).
 *
 * #2463 — `scripts/media-markdown-sync.py` was a 77-line stub whose docstring
 * promised yt-dlp downloads and beets tagging while the body only flipped a
 * markdown checkbox. It imported `subprocess`/`json`/`urllib.request`/`uuid`
 * without using any of them, defaulted `MARKDOWN_SYNC_DIR` to one
 * deployment's personal path, and was referenced by no template, systemd unit
 * or CI job. It was deleted rather than finished.
 *
 * #2464 — `scripts/maintenance/repair-admin-proxy-hosts.sh` hand-spliced
 * `SB_ADMIN_PASS` / `NPM_PASS` into JSON string literals. A password
 * containing `"`, `\` or a backtick produced malformed JSON, so the operator
 * got a generic HTTP-code failure mid-repair on a live box instead of a real
 * diagnostic. Bodies are now built by python3's `json.dumps`.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPAIR_SCRIPT = 'scripts/maintenance/repair-admin-proxy-hosts.sh';
const repairSource = fs.readFileSync(path.join(REPO_ROOT, REPAIR_SCRIPT), 'utf-8');

/**
 * Pull the shipped `json_body` definition out of the script and run it in
 * isolation. The script itself can't be sourced (it runs a full repair under
 * `set -euo pipefail`), so the test evals the real function text — no
 * reimplementation that could drift from what ships.
 */
function extractJsonBody(): string {
  const match = repairSource.match(/^json_body\(\) \{\n[\s\S]*?\n\}$/m);
  expect(match, `${REPAIR_SCRIPT} no longer defines a json_body() helper`).not.toBeNull();
  return match![0];
}

function runJsonBody(args: [string, string, string, string]): string {
  return execFileSync(
    'bash',
    ['-c', `${extractJsonBody()}\njson_body "$1" "$2" "$3" "$4"`, 'json_body_test', ...args],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 20_000 },
  );
}

describe('#2463 — the dead media-markdown-sync script is gone', () => {
  it('scripts/media-markdown-sync.py no longer exists', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'media-markdown-sync.py'))).toBe(false);
  });

  it('nothing tracked in the repo still references it', () => {
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);

    const offenders = tracked.filter((file) => {
      // This test file names the script in its own docs; skip itself.
      if (file.endsWith('maintenance-script-hygiene.test.ts')) return false;
      const full = path.join(REPO_ROOT, file);
      let body: string;
      try {
        body = fs.readFileSync(full, 'utf-8');
      } catch {
        return false; // binary / unreadable — can't reference a script path
      }
      return body.includes('media-markdown-sync');
    });

    expect(offenders, `dangling reference(s) to the deleted script`).toEqual([]);
  });
});

describe('#2464 — repair-admin-proxy-hosts.sh builds JSON safely', () => {
  it('no longer splices a password into a JSON string literal', () => {
    // The two bodies #2464 was filed over: the ServiceBay login and the NPM
    // /api/tokens login.
    expect(repairSource).not.toContain('\\"password\\":\\"$');
    expect(repairSource).not.toContain('\\"secret\\":\\"$');
    // And neither secret reaches curl except through the helper's output.
    expect(repairSource).toContain('json_body username "$SB_ADMIN_USER" password "$SB_ADMIN_PASS"');
    expect(repairSource).toContain('json_body identity "$NPM_EMAIL" secret "$NPM_PASS"');
  });

  it.each([
    ['a double quote', 'pa"ss'],
    ['a backslash', 'pa\\ss'],
    ['a backtick', 'pa`ss`'],
    ['a command substitution', 'pa$(id)ss'],
    ['a JSON-breaking mix', 'p"a\\s`s$(id)"{},:'],
    ['a newline', 'pa\nss'],
    ['a tab and unicode', 'pa\tssé☃'],
    ['a lone dollar-brace', 'pa${HOME}ss'],
  ])('survives a password containing %s', (_label, password) => {
    const out = runJsonBody(['username', 'admin', 'password', password]);
    // Valid JSON...
    const parsed = JSON.parse(out) as Record<string, string>;
    // ...that round-trips the password byte-for-byte, with no shell expansion.
    expect(parsed).toEqual({ username: 'admin', password });
  });

  it('round-trips the NPM identity/secret pair the same way', () => {
    const secret = 'np"m\\pa`ss$(whoami)';
    const parsed = JSON.parse(runJsonBody(['identity', 'a@b.test', 'secret', secret]));
    expect(parsed).toEqual({ identity: 'a@b.test', secret });
  });

  it('emits a single line starting with { so curl -d never reads it as a file', () => {
    // `curl -d @file` reads from disk; json.dumps output always begins with
    // `{`, so a password can't turn the body into a file read.
    const out = runJsonBody(['username', 'admin', 'password', '@/etc/passwd']).trim();
    expect(out.startsWith('{')).toBe(true);
    expect(out.split('\n')).toHaveLength(1);
  });
});
