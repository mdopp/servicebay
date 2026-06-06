/**
 * Hermes API-key reconcile (#1761) — adopt the bearer key the running
 * Hermes engine actually uses, rather than generating our own.
 *
 * Hermes ships as an external OSCAR template that ServiceBay does NOT
 * render: the template is deployed with its own `API_SERVER_KEY`, and
 * ServiceBay separately generates+persists a `HERMES_API_KEY` secret at
 * install. Those two can diverge — when they do, the maintenance-chat
 * route sends the wrong bearer, Hermes answers 401, and the route reports
 * the assistant as "unavailable" even though the engine is healthy.
 *
 * The durable fix is reconcile-not-generate (ADR 0009 style, mirroring the
 * OIDC client reconcile in #1741): read the key the running hermes
 * container actually uses (`API_SERVER_KEY` from its environment) and write
 * it into `installedSecrets.HERMES_API_KEY` via `persistSingleSecret`
 * (encrypted at rest). Idempotent, diff-visible, explicitly triggered — at
 * hermes deploy detection and as an operator diagnose heal-action. It NEVER
 * regenerates a key (that would break the running engine).
 *
 * SECURITY (#1761): the key is read over the agent/exec loopback seam only
 * (`podman exec <container> printenv`), stored encrypted via the existing
 * `installedSecrets` path, and is NEVER logged or returned to the browser —
 * the result reports only whether the value changed, never the value.
 */
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from '@/lib/install/savedSecrets';
import { logger } from '@/lib/logger';

/** The secret-variable name ServiceBay stores the Hermes bearer key under. */
const HERMES_API_KEY_VAR = 'HERMES_API_KEY';
/**
 * The env var the hermes (OSCAR) container reads its bearer key from. This
 * is the engine's source of truth — ServiceBay adopts whatever it holds.
 */
const HERMES_ENGINE_KEY_ENV = 'API_SERVER_KEY';
/**
 * Candidate container names for the running hermes engine. The OSCAR
 * template runs as `hermes-hermes` (pod-prefixed); a single-container
 * deploy may run as plain `hermes`. We try in order and use the first that
 * yields a non-empty key.
 */
const HERMES_CONTAINERS = ['hermes-hermes', 'hermes'];
const EXEC_TIMEOUT_S = 10;

/** Outcome of a reconcile attempt — diff-visible, never carries the key. */
export interface HermesKeyReconcileResult {
  /** `changed` wrote a new value; `aligned` already matched; `not-found`
   *  couldn't read a key from any candidate container; `error` on a
   *  transport/exec failure. */
  outcome: 'changed' | 'aligned' | 'not-found' | 'error';
  /** One-line, key-free summary suitable for a log line or action toast. */
  message: string;
}

interface ExecReply {
  code?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Read `API_SERVER_KEY` from the first reachable hermes container. Returns
 * the trimmed value, or `''` when no candidate container yields one (engine
 * not running, var unset). The key is never logged.
 */
async function readEngineKey(node: string): Promise<string> {
  const agent = await agentManager.ensureAgent(node);
  for (const container of HERMES_CONTAINERS) {
    let res: ExecReply;
    try {
      res = (await agent.sendCommand(
        'exec',
        {
          // `printenv` exits non-zero when the var is unset, so we tolerate a
          // non-zero exit and just read stdout. The value never hits the log.
          command: `podman exec ${container} printenv ${HERMES_ENGINE_KEY_ENV} 2>/dev/null || true`,
          timeout: EXEC_TIMEOUT_S,
        },
        { timeoutMs: EXEC_TIMEOUT_S * 1000 },
      )) as ExecReply;
    } catch (e) {
      // Container missing / not running for this candidate — try the next.
      logger.info(
        'hermes:reconcile',
        `exec against ${container} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    const value = (res.stdout ?? '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * Adopt the running Hermes engine's `API_SERVER_KEY` into
 * `installedSecrets.HERMES_API_KEY`. Idempotent: a no-op when the stored
 * value already matches. Never regenerates a key, never logs the key.
 *
 * @param node agent node name (defaults to the local box).
 */
export async function reconcileHermesApiKey(
  node: string = 'Local',
): Promise<HermesKeyReconcileResult> {
  let engineKey: string;
  try {
    engineKey = await readEngineKey(node);
  } catch (e) {
    const message = `Could not read the Hermes engine key: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn('hermes:reconcile', message);
    return { outcome: 'error', message };
  }

  if (!engineKey) {
    return {
      outcome: 'not-found',
      message:
        'Could not read API_SERVER_KEY from the running Hermes container — is the hermes service running?',
    };
  }

  const config = await getConfig();
  const stored = loadSavedSecrets(config)[HERMES_API_KEY_VAR] ?? '';
  if (stored === engineKey) {
    return {
      outcome: 'aligned',
      message: 'Hermes API key already matches the running engine — no change.',
    };
  }

  const wrote = await persistSingleSecret(HERMES_API_KEY_VAR, engineKey);
  logger.info(
    'hermes:reconcile',
    wrote
      ? 'Adopted the running Hermes engine API key into installedSecrets (encrypted at rest).'
      : 'Hermes API key reconcile resolved to no write.',
  );
  return {
    outcome: wrote ? 'changed' : 'aligned',
    message: wrote
      ? 'Adopted the running Hermes engine API key — maintenance chat will now authenticate.'
      : 'Hermes API key already matches the running engine — no change.',
  };
}
