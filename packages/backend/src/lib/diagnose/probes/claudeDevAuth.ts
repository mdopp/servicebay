/**
 * `claude_dev_auth` probe — is the dev box still signed in, and until when?
 *
 * The Claude sessions on this box start unattended at boot and are driven from
 * the Claude mobile app over Remote Control. Both of those depend on a sign-in
 * that expires, and nothing used to say so: the sessions simply stopped
 * answering, and the operator found out by opening the app.
 *
 * The probe reports three distinct states, because they need different actions:
 *
 *   1. `CLAUDE_CODE_OAUTH_TOKEN` is set → WARN, and this is the subtle one.
 *      A long-lived token (from `claude setup-token`) never expires for a year,
 *      so it looks like the better answer — but it is deliberately scoped to
 *      INFERENCE ONLY. `claude doctor` says it plainly: "Remote Control
 *      requires a full-scope login token. Long-lived tokens are limited to
 *      inference-only for security reasons." The sessions run fine and are
 *      invisible in the app. Nothing else on the box surfaces that trade.
 *   2. Signed in interactively → OK, with the expiry date and days remaining.
 *      Warn once it is inside {@link WARN_DAYS} so the re-login is a planned
 *      minute rather than a surprise outage.
 *   3. Not signed in / credentials gone → FAIL. One `claude auth login` in the
 *      container fixes every session at once: they share `HOME=/workspace`,
 *      so they share `~/.claude/.credentials.json`.
 *
 * SECURITY: only `refreshTokenExpiresAt` is extracted, and the extraction runs
 * ON THE NODE — the grep returns a timestamp, so no token ever crosses into
 * the backend, is logged, or reaches a probe message.
 */
import yaml from 'js-yaml';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { ServiceManager } from '@/lib/services/ServiceManager';

const SERVICE = 'claude-dev';
const TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
const WORKSPACE_MOUNT = '/workspace';
/** The pod names its single container `<service>-<service>`. */
const CONTAINER = `${SERVICE}-${SERVICE}`;
/**
 * One-tap repair. `run=claude-login` is a whitelisted preset in the terminal's
 * session manager, not a command in the URL — see TERMINAL_RUN_PRESETS. It
 * opens a terminal in the container with the sign-in already running, which is
 * the whole point: the operator is usually holding a phone when they discover
 * the sessions have gone quiet, and SSH plus a typed command is not something
 * you do from there.
 */
const LOGIN_DEEP_LINK = `/terminal?container=${CONTAINER}&run=claude-login`;
/** Days of remaining validity below which the sign-in is reported as a warning. */
const WARN_DAYS = 7;

export interface ClaudeDevAuthResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
}

/** Minimal agent surface — keeps this file decoupled from the full manager type. */
type ExecAgent = {
  sendCommand(
    action: string,
    params?: { command?: string },
    opts?: { timeoutMs?: number },
  ): Promise<{ code?: number; stdout?: string; stderr?: string }>;
};

/** The slice of a pod manifest this probe reads; everything else is ignored. */
interface PodLike {
  spec?: {
    containers?: Array<{
      env?: Array<{ name?: string; value?: unknown }> | null;
      volumeMounts?: Array<{ name?: string; mountPath?: string }> | null;
    } | null> | null;
    volumes?: Array<{ name?: string; hostPath?: { path?: string } | null }> | null;
  };
}

/** True when the pod passes a non-empty token. A blank-but-present entry — what
 *  a template re-render produces for a `noAutoGenerate` secret — reads as unset. */
export function podHasToken(doc: PodLike): boolean {
  return (doc.spec?.containers ?? []).some((c) =>
    (c?.env ?? []).some(
      (e) => e?.name === TOKEN_VAR && typeof e.value === 'string' && e.value.trim() !== '',
    ),
  );
}

/** Host path backing the `/workspace` mount, or null when the pod is shaped
 *  differently than expected. Derived rather than hard-coded so a box with a
 *  non-default DATA_DIR still resolves. */
export function workspaceHostPath(doc: PodLike): string | null {
  const containers = doc.spec?.containers ?? [];
  for (const c of containers) {
    const mount = (c?.volumeMounts ?? []).find((m) => m?.mountPath === WORKSPACE_MOUNT);
    if (!mount?.name) continue;
    const vol = (doc.spec?.volumes ?? []).find((v) => v?.name === mount.name);
    const p = vol?.hostPath?.path;
    if (typeof p === 'string' && p.startsWith('/')) return p;
  }
  return null;
}

/** Whole days from now until `iso`; negative once it has passed. */
export function daysUntil(iso: string, now: number): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

export async function checkClaudeDevAuth(nodeName: string): Promise<ClaudeDevAuthResult> {
  const config = await getConfig();
  if (!config.installedTemplates?.[SERVICE]) {
    return {
      status: 'info',
      detail: 'claude-dev is not installed — no unattended Claude sessions to keep signed in.',
    };
  }

  let doc: PodLike;
  try {
    const { yamlContent } = await ServiceManager.getServiceFiles(nodeName, SERVICE);
    doc = (yaml.load(yamlContent) ?? {}) as PodLike;
  } catch (e) {
    return {
      status: 'info',
      detail: `Skipped: could not read the ${SERVICE} pod definition (${e instanceof Error ? e.message : String(e)}).`,
    };
  }

  if (podHasToken(doc)) {
    return {
      status: 'warn',
      detail:
        `${TOKEN_VAR} is set. The sessions stay authenticated for the token's full year, but a ` +
        'long-lived token is scoped to inference only — Remote Control is unavailable, so none of ' +
        'them appear in the Claude mobile app or on claude.ai/code.',
      // NOTE: no backticks in these message strings. An escaped backtick inside
      // a template literal that is then concatenated with a quoted string gets
      // mis-escaped when the frontend build inlines the pieces, and the emitted
      // chunk terminates its template early — a build failure that `tsc` cannot
      // see, because the source is perfectly valid. Plain quotes also match how
      // the other probes word their hints.
      hint:
        `Clear ${TOKEN_VAR} and run "claude auth login" in the container if you drive these ` +
        'sessions from the app. Keep the token only if this box is never operated remotely. ' +
        '"claude doctor" reports the same thing under Remote Control.',
    };
  }

  const hostPath = workspaceHostPath(doc);
  if (!hostPath) {
    return {
      status: 'info',
      detail: `Skipped: no host path found for the ${WORKSPACE_MOUNT} volume, so the sign-in state could not be read.`,
    };
  }

  // Only the timestamp leaves the node. `sudo` because the credentials file is
  // mode 0600 and owned by the container's mapped uid; `-o` so the match — not
  // the file — is what the agent returns.
  const credPath = `${hostPath}/.claude/.credentials.json`;
  let stdout = '';
  try {
    const agent = (await agentManager.ensureAgent(nodeName)) as unknown as ExecAgent;
    const res = await agent.sendCommand(
      'exec',
      { command: `sudo grep -o '"refreshTokenExpiresAt":[0-9]*' ${credPath} 2>/dev/null || true` },
      { timeoutMs: 10_000 },
    );
    stdout = (res.stdout ?? '').trim();
  } catch (e) {
    logger.warn(
      'diagnose:claude_dev_auth',
      `could not read the sign-in state: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { status: 'info', detail: 'Skipped: the sign-in state could not be read from the node.' };
  }

  const match = stdout.match(/"refreshTokenExpiresAt":(\d+)/);
  const expiry = match ? new Date(Number(match[1])) : null;
  const stamp = expiry ? expiry.toISOString().slice(0, 10) : null;
  const days = expiry ? daysUntil(expiry.toISOString(), Date.now()) : null;

  // The expiry date alone is NOT the health signal, and assuming it was would
  // have shipped a probe that lies. Measured on the reference box: the stored
  // credentials were a full-scope `max` subscription whose refresh token had 26
  // days left, while `claude doctor` correctly reported "Not signed in to
  // claude.ai" — the access token had been zeroed (`expiresAt: 0`) and never
  // renewed. A probe keyed on the date would have shown a comfortable green for
  // most of a month while every session was dead and absent from the app.
  //
  // So ask the tool that actually knows. `claude doctor` prints a Remote Control
  // section listing every failing check; when nothing fails it prints only the
  // "Control this session from claude.ai/code…" line. Absence of `- ` check
  // lines is therefore the availability signal, and their text is the reason.
  const doctor = await remoteControlReport(nodeName);
  if (!doctor) {
    return { status: 'info', detail: 'Skipped: "claude doctor" could not be run in the container.' };
  }
  const until = stamp ? ` Stored sign-in runs to ${stamp} (${days} days).` : '';

  if (doctor.failures.length === 0) {
    return {
      status: 'ok',
      detail: `Signed in and reachable — Remote Control is available, so the sessions show up in the Claude app.${until}`,
    };
  }
  return {
    status: 'fail',
    detail:
      `The Claude sessions are not reachable from the app: ${doctor.failures.join('; ')}.` +
      `${until ? until + ' A stored expiry in the future does NOT mean the sign-in still works.' : ''}`,
    hint:
      `Open ${LOGIN_DEEP_LINK} — it drops you straight into the container with "claude auth ` +
      'login" already running, so there is nothing to remember, no SSH and no typing (it works ' +
      'from a phone). All sessions share HOME=/workspace and therefore one credential file, so ' +
      'a single sign-in covers every one of them; restart the service afterwards so the running ' +
      'sessions pick it up.',
  };
}

/** Failing Remote Control checks as `claude doctor` reports them, or null when
 *  the command could not be run. An empty list means Remote Control is live. */
async function remoteControlReport(nodeName: string): Promise<{ failures: string[] } | null> {
  try {
    const agent = (await agentManager.ensureAgent(nodeName)) as unknown as ExecAgent;
    const res = await agent.sendCommand(
      'exec',
      {
        command:
          `podman exec ${CONTAINER} runuser -u dev -- ` +
          `env HOME=${WORKSPACE_MOUNT} claude doctor 2>&1 | sed -n '/Remote Control/,/^$/p'`,
      },
      { timeoutMs: 30_000 },
    );
    const block = res.stdout ?? '';
    if (!block.includes('Remote Control')) return null;
    const failures = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2));
    return { failures };
  } catch (e) {
    logger.warn(
      'diagnose:claude_dev_auth',
      `could not run claude doctor: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
