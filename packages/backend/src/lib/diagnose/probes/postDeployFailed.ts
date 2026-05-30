/**
 * `post_deploy_failed` probe (B8 / #241) — surfaces services whose
 * last `post-deploy.py` run exited non-zero. Without this signal,
 * silent seed failures (LLDAP not initialized, NPM proxy host not
 * created, FileBrowser admin not promoted) sit there indefinitely;
 * the install log already scrolled away and there's no other place
 * the operator would notice.
 *
 * Each failed service shows up as one item in the probe with two
 * actions:
 *   - `rerun_post_deploy` (per-item) — re-runs the same script the
 *     original deploy ran, using the env file already on disk.
 *   - `dismiss_post_deploy` (per-item) — clears the persisted
 *     failure for that service so the probe stops nagging when the
 *     operator has fixed it manually.
 *
 * Reads `config.servicePostDeploy[name]` written by
 * `ServiceManager.runPostDeployScript`. See #252 for the schema.
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig, updateConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'post_deploy_failed';

export interface PostDeployFailedResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

export async function checkPostDeployFailed(): Promise<PostDeployFailedResult> {
  const config = await getConfig();
  const records = config.servicePostDeploy ?? {};
  const failed = Object.entries(records).filter(([, r]) => r.exitCode !== 0);
  if (Object.keys(records).length === 0) {
    return {
      status: 'info',
      detail: 'No post-deploy runs recorded yet — either no services are installed or they predate the persistence change.',
    };
  }
  if (failed.length === 0) {
    return {
      status: 'ok',
      detail: `${Object.keys(records).length} post-deploy run(s) recorded, all exited 0.`,
    };
  }
  const items: ProbeItem[] = failed.map(([name, r]) => {
    // Surface the last few lines of stdout when persisted (recorded
    // by ServiceManager.runPostDeployScript). Without this the row
    // says "exit 1" and the operator has to open the service detail
    // to find the actual error — usually 2-3 lines that name the
    // missing env var / failed API call / etc. directly.
    const tail = (r.stdoutTail ?? '').trim();
    const tailExcerpt = tail
      ? '\n' + tail.split('\n').slice(-3).join('\n').slice(-240)
      : '';
    return {
      id: name,
      label: name,
      detail: `exit ${r.exitCode} at ${new Date(r.lastRunAt).toLocaleString()}${tailExcerpt}`,
      status: 'warn',
      actionIds: ['rerun_post_deploy', 'dismiss_post_deploy'],
    };
  });
  return {
    status: 'warn',
    detail: `${failed.length} service${failed.length === 1 ? '' : 's'} ended its last post-deploy with a non-zero exit. Seeds (admin users, default proxy hosts, etc.) likely didn\'t complete.`,
    hint: 'Click "Re-run post-install" on a row to repeat the seed step. The script + env are already on disk from the original run.',
    items,
  };
}

/**
 * Persist a post-deploy re-run's outcome to servicePostDeploy so the probe
 * transitions to ok / stays warn. Failure to persist is non-fatal (logged).
 * Extracted from rerunPostDeploy to keep it under the line limit.
 */
async function persistRerunResult(
  itemId: string,
  result: { code?: number; stdout?: string },
): Promise<void> {
  const stdoutTail = (result.stdout ?? '').slice(-1024) || undefined;
  try {
    await updateConfig({
      servicePostDeploy: {
        [itemId]: {
          lastRunAt: new Date().toISOString(),
          exitCode: result.code ?? -1,
          stdoutTail,
        },
      },
    });
  } catch (e) {
    logger.warn('diagnose:post_deploy_failed', `Could not persist re-run for ${itemId}:`, e);
  }
}

async function rerunPostDeploy({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No service id supplied.', refresh: false };
  }
  const agent = await agentManager.ensureAgent(node);
  const scriptDir = `~/.local/share/servicebay/post-deploy`;
  const scriptPath = `${scriptDir}/${itemId}.py`;
  const envPath = `${scriptDir}/${itemId}.env`;
  // Verify the artifacts are still on disk before trying to re-run.
  const check = await agent.sendCommand('exec', {
    command: `test -f ${scriptPath} && test -f ${envPath} && echo ok`,
  }, { timeoutMs: 5_000 });
  if ((check as { stdout?: string }).stdout?.trim() !== 'ok') {
    return {
      ok: false,
      message: `Couldn't find the original post-deploy artifacts for ${itemId} on the node. Re-run a Settings → Services → ${itemId} → redeploy to regenerate them.`,
      refresh: false,
    };
  }
  // The original deploy used a 20-min client budget; the same applies
  // here. exec_stream isn't strictly needed — the operator already saw
  // the failure once; re-runs surface success/failure in the toast.
  const result = await agent.sendCommand('exec', {
    command: `set -a; source ${envPath}; set +a; python3 ${scriptPath} 2>&1`,
    timeout: 1200,
  }, { timeoutMs: 1_200_000 }) as { code?: number; stdout?: string };

  // Persist the new run so the probe transitions to ok / stays warn.
  await persistRerunResult(itemId, result);

  if (result.code === 0) {
    return {
      ok: true,
      message: `${itemId} post-deploy re-run succeeded.`,
      refresh: true,
    };
  }
  // Tail the last line of stdout so the operator gets a concrete hint
  // in the toast — usually that's where the script's own error message
  // landed.
  const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  return {
    ok: false,
    message: `${itemId} re-run still failed (exit ${result.code}). ${lastLine ? `Last log line: ${lastLine.slice(0, 200)}` : ''}`,
    refresh: true,
  };
}

async function dismissPostDeploy({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No service id supplied.', refresh: false };
  }
  const config = await getConfig();
  const records = { ...(config.servicePostDeploy ?? {}) };
  if (!(itemId in records)) {
    return { ok: false, message: `No post-deploy record for ${itemId}.`, refresh: false };
  }
  delete records[itemId];
  // updateConfig deep-merges, so we need to write the whole object —
  // a simple merge would re-add the missing key from the previous
  // value. Re-save the full config explicitly.
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ ...config, servicePostDeploy: records });
  return {
    ok: true,
    message: `Cleared post-deploy record for ${itemId}.`,
    refresh: true,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'rerun_post_deploy',
    label: 'Re-run post-install',
    description:
      'Re-runs the seed script for this service using the same env file the original deploy generated. Idempotent for well-written scripts (admin user already exists → skip; proxy host already created → skip).',
  },
  rerunPostDeploy,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'dismiss_post_deploy',
    label: 'Clear record',
    description:
      'Removes the persisted failure record for this service so the probe stops surfacing it. Use when you fixed the seed manually and don\'t want the warning anymore.',
  },
  dismissPostDeploy,
);
