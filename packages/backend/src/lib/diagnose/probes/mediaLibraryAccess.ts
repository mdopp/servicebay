/**
 * `media_library_access` probe (#2040) — an on-demand "Re-sync Jellyfin
 * library access" action for the media (Jellyfin) service.
 *
 * The friction it removes: Jellyfin authenticates via its own LDAP-Auth
 * plugin (`CreateUsersFromLdap=true`), so a brand-new LLDAP user's
 * account doesn't exist in Jellyfin until they log in for the first time.
 * The media post-deploy's `jellyfin_set_user_access()` grants each user
 * the PUBLIC libraries plus THEIR OWN private libraries
 * (`data/<user>/<category>`) — but it can only do that for users who
 * already exist. A user who just logged in for the first time therefore
 * sees only the public libraries until the *next* `media` stack
 * redeploy re-runs the grant. There's no failure to surface (the deploy
 * succeeded), so the generic `post_deploy_failed` row never lights up —
 * the operator's only recourse today is a full stack reinstall.
 *
 * This probe always offers (whenever `media` is installed) a single
 * `resync_jellyfin_access` action. It re-runs the media post-deploy
 * script already on disk (`~/.local/share/servicebay/post-deploy/
 * media.{py,env}` — the same artifacts `post_deploy_failed`'s
 * `rerun_post_deploy` uses). That script is idempotent + self-healing:
 * libraries skip-if-exists and `jellyfin_set_user_access` re-applies the
 * public + per-user-private grant to every now-existing user. So a new
 * user who has logged in once gets their private libraries granted
 * without a reinstall — reusing the #2027 machinery, no Python change.
 *
 * Steady-state status is `ok` (action available) when media is installed,
 * `info` (nothing to do) when it isn't.
 */

import { agentManager } from '@/lib/agent/manager';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'media_library_access';
const MEDIA_SERVICE = 'media';

export interface MediaLibraryAccessResult {
  /** `null` means media isn't installed — the caller omits the probe
   *  (and its action) entirely so a box without Jellyfin shows no
   *  "Re-sync library access" button. `info` (never `ok`) when media is
   *  installed: `ok` would make the diagnose route strip the action,
   *  and a permanent `warn` would nag a healthy box (UX philosophy). */
  status: 'info' | null;
  detail: string;
  hint?: string;
}

/** True when the `media` service is present on the node (installed). The
 *  active flag doesn't matter for offering the action — the on-disk
 *  post-deploy artifacts persist regardless of whether the unit is
 *  currently up, and the re-run starts the container's API as needed. */
async function isMediaInstalled(node: string): Promise<boolean> {
  const services = await ServiceManager.listServices(node);
  return services.some(s => s.name === MEDIA_SERVICE);
}

export async function checkMediaLibraryAccess(node: string): Promise<MediaLibraryAccessResult> {
  if (!(await isMediaInstalled(node))) {
    return {
      status: null,
      detail: 'Media (Jellyfin) is not installed — no Jellyfin library access to re-sync.',
    };
  }
  return {
    status: 'info',
    detail:
      'Jellyfin library access can be re-synced on demand. New users who just logged in for the first time get only the public libraries until their private libraries are granted.',
    hint:
      'A user who logged into Jellyfin for the first time and is missing their own private libraries? Click "Re-sync library access" — no reinstall needed.',
  };
}

/**
 * Re-run the media post-deploy script on the node. It re-runs
 * `jellyfin_set_user_access()` (among the other idempotent seed steps),
 * granting every now-existing Jellyfin user the public libraries plus
 * their own private ones. Mirrors `post_deploy_failed`'s
 * `rerun_post_deploy` — same artifacts, same 20-min budget — but is
 * always available (not gated on a recorded failure).
 */
async function resyncJellyfinAccess({ node }: { node: string }): Promise<ProbeActionResult> {
  const agent = await agentManager.ensureAgent(node);
  const scriptDir = `~/.local/share/servicebay/post-deploy`;
  const scriptPath = `${scriptDir}/${MEDIA_SERVICE}.py`;
  const envPath = `${scriptDir}/${MEDIA_SERVICE}.env`;
  // Verify the artifacts are still on disk before trying to re-run.
  const check = await agent.sendCommand('exec', {
    command: `test -f ${scriptPath} && test -f ${envPath} && echo ok`,
  }, { timeoutMs: 5_000 });
  if ((check as { stdout?: string }).stdout?.trim() !== 'ok') {
    return {
      ok: false,
      message:
        'Couldn\'t find the media post-deploy artifacts on the node. Redeploy media once (Settings → Services → media) to regenerate them, then try again.',
      refresh: false,
    };
  }
  const result = await agent.sendCommand('exec', {
    command: `set -a; source ${envPath}; set +a; python3 ${scriptPath} 2>&1`,
    timeout: 1200,
  }, { timeoutMs: 1_200_000 }) as { code?: number; stdout?: string };

  const tail = (result.stdout ?? '').trim().split('\n').slice(-6).join('\n');
  if (result.code === 0) {
    return {
      ok: true,
      message: 'Re-synced Jellyfin library access. Each user now has the public libraries plus their own private ones.',
      details: tail || undefined,
      refresh: true,
    };
  }
  const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? '';
  return {
    ok: false,
    message: `Re-sync failed (exit ${result.code}). ${lastLine ? `Last log line: ${lastLine.slice(0, 200)}` : ''}`,
    details: tail || undefined,
    refresh: true,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'resync_jellyfin_access',
    label: 'Re-sync library access',
    description:
      'Re-runs the media seed step that grants each Jellyfin user the public libraries plus their own private ones. Use after a new user logs in for the first time so their private libraries appear — no stack reinstall needed. Idempotent.',
  },
  resyncJellyfinAccess,
);

export { PROBE_ID };
