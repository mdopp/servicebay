/*
 * The claude-dev configuration UI's ONE ServiceBay client (#2910, epic #2903).
 *
 * This UI used to speak the token-delegation route itself: its own fetch
 * wrapper, its own error shaping, its own copy of the path. solarisbay's
 * `pi-web-project` spoke the same routes a second time. Three copies of one
 * contract age apart in silence — which is the defect the epic is about — so
 * the route knowledge now lives in exactly ONE place, the agent CLI's verb
 * table (`agent-cli/servicebay.mjs`, pinned against the real routes by #2907),
 * and this file calls it. A route rename is one edit now, and it breaks loudly.
 *
 * WHERE THE CLI COMES FROM. The delivered agent kit, not this image: the kit is
 * a git checkout ServiceBay drops on the box and refreshes hourly (ADR 0014,
 * #2908) and the claude-dev pod mounts it read-only at `AGENT_CLI_PATH`. A copy
 * baked into the image would be the second source that whole decision exists to
 * prevent — and it would age exactly the way the hand-written client did.
 *
 * HOW IT IS CALLED. In process (`run(argv, deps)`), not spawned. The parent
 * token then never reaches a child process's environment and never goes
 * anywhere near argv — `/proc/<pid>/cmdline` is world-readable and this
 * container has real user logins on it. `--json` is the machine contract: the
 * envelope is `{ ok: true, verb, data }` or `{ ok: false, verb, error }`, and
 * `error.status` is what lets a caller tell "already gone" from "refused".
 *
 * WHY A SIBLING MODULE rather than a section of `server.mjs`:
 *   - it is the only file in this UI that may reach ServiceBay at all, so it is
 *     the only file to read to answer "what does the config UI ask the box
 *     for". `server.mjs` imports from here and never the reverse;
 *   - the runtime `import()` of the delivered CLI has to sit in a file with NO
 *     shebang: a bundler/test transform prepends its own import line at offset
 *     0 when it sees a dynamic import, and a `#!` there stops the file parsing.
 *
 * `ProjectError` lives here because this is the lowest layer that raises one.
 * Its contract is the pair the route wrapper reads off a thrown error:
 * `status` and `detail`.
 */

import { pathToFileURL } from 'node:url';

/** An HTTP-shaped failure: `status` becomes the response code, `detail` its
 *  second line. Thrown from here and from `server.mjs`'s project mechanics. */
export class ProjectError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Where the pod manifest mounts the delivered agent kit, read-only. */
export const AGENT_CLI_PATH = '/opt/servicebay/agent-kit/agent-cli/servicebay.mjs';

/** One import per path, for the life of the process. */
const agentCliCache = new Map();

async function loadAgentCli(cliPath) {
  let mod = agentCliCache.get(cliPath);
  if (!mod) {
    try {
      mod = await import(/* @vite-ignore */ pathToFileURL(cliPath).href);
    } catch (err) {
      throw new ProjectError(503,
        `the ServiceBay agent CLI is not available at ${cliPath}`,
        'The claude-dev pod mounts the delivered agent kit read-only; without that mount this page can '
        + `neither delegate nor revoke a project token. ${String(err?.message || err).slice(0, 200)}`);
    }
    agentCliCache.set(cliPath, mod);
  }
  return mod;
}

/** Run one CLI verb and hand back its `--json` envelope. */
async function runAgentCli(servicebay, argv, doFetch) {
  if (!servicebay?.token) {
    throw new ProjectError(503, 'this container holds no ServiceBay API token, so it cannot delegate one to a project');
  }
  const cli = await loadAgentCli(servicebay.cli || AGENT_CLI_PATH);
  const result = await cli.run([...argv, '--json'], {
    // The token reaches the CLI the same way it reached this server: in
    // memory, through the object it is handed. Never a real process
    // environment, never an argument.
    env: { SERVICEBAY_API_URL: servicebay.url, SERVICEBAY_MCP_TOKEN: servicebay.token },
    fetch: doFetch,
  });
  let payload = null;
  try { payload = JSON.parse(result.stdout); } catch { payload = null; }
  if (!payload) {
    // `--json` answers on stdout for success AND failure alike, so nothing
    // readable there means the invocation never reached a verb: a usage error
    // from this file, or — the one that will really happen — a kit checkout
    // older than this image, which does not carry the verb yet. Say so; the
    // hourly refresh fixes the second on its own.
    throw new ProjectError(502,
      `the ServiceBay agent CLI answered nothing readable for \`${argv[0]}\``,
      'Either this call is malformed, or the delivered agent kit is older than this container and has no '
      + `\`${argv[0]}\` verb yet — ServiceBay refreshes it at boot and hourly. The CLI said: `
      + String(result.stderr || result.stdout || '(nothing)').slice(0, 200));
  }
  return payload;
}

/** Mint a read-only child of this container's token, bound to one project. */
export async function delegateProjectToken(servicebay, name, doFetch) {
  // Read-only, like the parent: a project session that genuinely needs more
  // goes through `request_token`, which itself needs only `read`.
  const res = await runAgentCli(servicebay, ['delegate', `claude-dev project ${name}`, '--scopes', 'read'], doFetch);
  if (!res.ok || typeof res.data?.secret !== 'string') {
    throw new ProjectError(502,
      `ServiceBay refused to delegate a token for "${name}"`,
      res.error?.message || 'the agent CLI returned no secret');
  }
  return { secret: res.data.secret, id: res.data.token?.id ?? '', scopes: res.data.token?.scopes ?? [] };
}

/**
 * Revoke one delegated child. `404` comes back as `alreadyGone` rather than an
 * error so a remove that failed halfway can be retried to completion — every
 * other refusal is surfaced, because "revoked nothing" must never read as
 * "revoked it".
 */
export async function revokeProjectToken(servicebay, tokenId, doFetch) {
  const res = await runAgentCli(servicebay, ['revoke', tokenId], doFetch);
  if (res.ok) return { revoked: true, alreadyGone: false };
  if (res.error?.status === 404) return { revoked: false, alreadyGone: true };
  throw new ProjectError(502,
    `ServiceBay refused to revoke this project's token (${tokenId})`,
    res.error?.message || `the agent CLI failed with ${res.error?.code || 'no code'}`);
}
