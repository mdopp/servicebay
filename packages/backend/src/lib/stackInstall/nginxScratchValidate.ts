/**
 * Scratch `nginx -t` validation — the cheap half of box-verify's
 * "render-only" fast path (perf: speed up box-verify).
 *
 * A render-only change (e.g. the X-SB-Internal-Token injection in
 * `forwardAuth.ts` / `portal/provisioner.ts`, `proxy.ts` untouched) doesn't
 * change the running app's request handling — only what NPM config gets
 * *rendered*. Its correctness is therefore a pure render, and the one live
 * risk is that a bad `advanced_config` breaks nginx with an `[emerg]`
 * duplicate-location / invalid-port (memory
 * `reference_proxy_authskippaths_nginx_gotchas`). This module lets box-verify
 * prove nginx accepts the rendered config in a THROWAWAY container — no
 * `:dev` flip, no live NPM redeploy — mirroring the post-write `nginx -t` +
 * rollback guard in `proxy-hosts/route.ts` and the `nginx_config_valid` health
 * probe, but pre-deployment and side-effect-free.
 *
 * The command shape here was validated live against the box's real NPM image
 * (jc21/nginx-proxy-manager), which surfaced three things unit tests cannot:
 *   1. a host bind-mount of the config is SELinux-blocked (rootless podman) —
 *      so the config is piped via STDIN and written INSIDE the container;
 *   2. `nginx -t` setuid's to the image's `nginx` user (absent in a bare run)
 *      → pin `user root;`;
 *   3. `nginx -t` needs its default temp/log dirs → redirect temp paths under
 *      `/tmp` and `access_log off;` (a bare run has no /var/cache|/var/log).
 * A single harmless `[alert] could not open error log file` line is emitted
 * before the config is parsed; it is not an `[emerg]` and does not fail the
 * test.
 *
 * The functions here are pure command/string builders so the wrapping and
 * parse logic are unit-tested without a node. box-verify runs the returned
 * command via the `exec_command` MCP tool.
 */

/** Default port substituted for a bare `{{AUTHELIA_PORT}}` if the caller
 *  didn't already expand it via `renderForwardAuthAdvancedConfig`. */
export const SCRATCH_DEFAULT_SUBS: Readonly<Record<string, string>> = {
  AUTHELIA_PORT: '9091',
};

/** Container-internal path the piped config is written to before `nginx -t`.
 *  Never a host path — the config never lands on the box filesystem. */
export const SCRATCH_CONF_PATH = '/tmp/sb-scratch-nginx.conf';

/** Container-internal base for nginx's temp dirs (a bare run lacks
 *  /var/cache/nginx). */
export const SCRATCH_TMP_BASE = '/tmp/sb-scratch-nginx';

export interface ScratchNginxParse {
  ok: boolean;
  /** The `nginx: [emerg] ...` line, when one is present. */
  emergLine?: string;
}

/**
 * Expand any remaining `{{KEY}}` NPM placeholders (with optional inner
 * whitespace) using `subs`, then wrap the forward-auth / proxy `location`
 * snippet in a minimal, self-contained nginx config so `nginx -t` can parse
 * it standalone. The harness pins `user root;`, silences the default
 * access/error logs, and redirects temp paths under `/tmp` so a bare
 * (non-entrypoint) container run validates cleanly — see the file header for
 * why each is needed. `nginx -t` checks syntax + duplicate-location /
 * invalid-port without connecting to any upstream.
 *
 * Pure: same input → same output.
 */
export function wrapSnippetInScratchConfig(
  snippet: string,
  subs: Record<string, string> = SCRATCH_DEFAULT_SUBS,
): string {
  const expanded = snippet.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(subs, key) ? subs[key] : whole,
  );
  const indented = expanded
    .split('\n')
    .map(line => (line.length ? `      ${line}` : line))
    .join('\n');
  return [
    'user root;',
    'error_log stderr;',
    'events {}',
    'http {',
    '  access_log off;',
    `  client_body_temp_path ${SCRATCH_TMP_BASE}/client;`,
    `  proxy_temp_path ${SCRATCH_TMP_BASE}/proxy;`,
    `  fastcgi_temp_path ${SCRATCH_TMP_BASE}/fastcgi;`,
    `  uwsgi_temp_path ${SCRATCH_TMP_BASE}/uwsgi;`,
    `  scgi_temp_path ${SCRATCH_TMP_BASE}/scgi;`,
    '  server {',
    '    listen 8080;',
    '    server_name _;',
    indented,
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * Build the single box command that validates a wrapped config in a throwaway
 * container off the NPM image. The config is base64-piped to the container's
 * stdin, decoded and written INSIDE it, then `nginx -t`'d — no host file, no
 * bind-mount (avoids the rootless-podman/SELinux read block), `--rm` so the
 * container is gone regardless of outcome; the live NPM is never touched.
 *
 * `wrappedConf` should be the output of `wrapSnippetInScratchConfig`.
 * `npmImageRef` is the NPM (nginx-proxy-manager) image reference — resolve on
 * the box via `podman ps --format '{{.Image}}' | grep proxy-manager`. Run the
 * returned command via `exec_command` and pass its combined output + exit code
 * to `parseScratchNginxOutput`.
 *
 * Pure: returns a command string; the caller executes it.
 */
export function buildScratchNginxValidateCommand(
  wrappedConf: string,
  npmImageRef: string,
  confPath: string = SCRATCH_CONF_PATH,
): string {
  const b64 = Buffer.from(wrappedConf, 'utf8').toString('base64');
  const inner = `mkdir -p ${SCRATCH_TMP_BASE} && base64 -d > ${confPath} && nginx -t -c ${confPath}`;
  return (
    `printf %s '${b64}' | ` +
    `podman run --rm -i --user root --entrypoint sh ${npmImageRef} -c '${inner}' 2>&1`
  );
}

/**
 * Parse the combined stdout+stderr of the scratch `nginx -t` plus its exit
 * code. Exit 0 → valid. Non-zero → invalid; pull out the first `[emerg]`
 * line. Mirrors `parseNginxTestOutput` in
 * `lib/health/probes/nginxConfigValid.ts` (kept local so this render-layer
 * helper stays free of that probe module's registration side-effect).
 */
export function parseScratchNginxOutput(output: string, exitCode: number): ScratchNginxParse {
  if (exitCode === 0) return { ok: true };
  // nginx -t emits its runtime [emerg] lines with a timestamp prefix
  // (`2026/07/14 15:21 [emerg] ...`), NOT the `nginx: [emerg]` form the
  // health probe assumes — match the whole line containing `[emerg]`.
  const emergMatch = (output ?? '').match(/^.*\[emerg\].*$/m);
  return { ok: false, emergLine: emergMatch ? emergMatch[0].trim() : undefined };
}
