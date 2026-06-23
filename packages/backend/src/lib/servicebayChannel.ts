/**
 * Switch the *running* ServiceBay container between release channels by
 * re-pointing its quadlet image tag and restarting.
 *
 * The build wizard bakes a channel into the USB (render.go:VersionFromChannel);
 * this flips an already-installed box at runtime — chiefly so a fix merged to
 * `main` (auto-published by release.yml as `:dev`) can be verified on the box
 * WITHOUT cutting a release. A reinstall re-bakes from the wizard's choice, so
 * a runtime switch is ephemeral.
 *
 * Channel → ghcr tag (release.yml):
 *   - `latest` — the last release.
 *   - `dev`    — the latest non-release commit on `main`.
 *   - `test`   — the `test` branch.
 */
import { getExecutor } from '@/lib/executor';
import { logger } from '@/lib/logger';

export const CHANNELS = ['latest', 'dev', 'test'] as const;
export type Channel = (typeof CHANNELS)[number];

const IMAGE = 'ghcr.io/mdopp/servicebay';
// $HOME (the box user's home) is resolved by the `sh -c` shell, not us — the
// quadlet path varies by user, so we don't hardcode it. The script is a FIXED
// string; the only variable (channel) is passed as a positional ($1), never
// interpolated, so there's no shell-injection surface (and it's enum-checked).
const SWAP_TAG_SH = 'sed -i -E "s#(servicebay):[A-Za-z0-9._-]+#\\1:$1#" "$HOME/.config/containers/systemd/servicebay.container"';

export function isChannel(s: string): s is Channel {
  return (CHANNELS as readonly string[]).includes(s);
}

/** The channel actually in effect — read from the RUNNING container's image
 *  tag, not the quadlet (which can already show a pending switch before the
 *  restart lands). So a caller polling this only sees the new channel once the
 *  box has restarted onto it. Falls back to 'latest' if unparseable. */
export async function getServicebayChannel(): Promise<string> {
  const { stdout } = await getExecutor('Local').execArgv(['podman', 'inspect', 'servicebay', '--format', '{{.ImageName}}']);
  const tag = stdout.trim().match(/:([A-Za-z0-9._-]+)$/);
  return tag ? tag[1] : 'latest';
}

/**
 * Re-point the quadlet to `:<channel>`, pull the new image (errors surfaced to
 * the caller), then recreate + restart the container in the background.
 *
 * The tag swap and the pull are **awaited** so a bad quadlet write or a pull
 * failure (e.g. `:dev` not found / ghcr auth) surfaces synchronously — the
 * caller must not get `ok:true` while the switch silently rolls back (#2064).
 * Only the recreate + `--no-block` restart run detached, so the HTTP response
 * returns before ServiceBay (which is serving it) goes down.
 *
 * Recreate, not a plain restart: `systemctl restart` reuses the *existing*
 * container definition, so it keeps running the OLD image even after the new
 * one is pulled — a same-tag (`:latest`→`:latest`) re-pull silently no-ops
 * (#2063). `podman rm -f` forces the quadlet unit to recreate the container
 * from the freshly-pulled, re-pointed image on the next start, so the switch
 * actually lands. (rm runs detached with the restart because it tears down the
 * very process serving this request.)
 */
export async function setServicebayChannel(channel: Channel): Promise<void> {
  if (!isChannel(channel)) {
    throw new Error(`Unknown channel "${channel}". Use one of: ${CHANNELS.join(', ')}.`);
  }
  const executor = getExecutor('Local');
  // Swap `…/servicebay:<anything>` → `…/servicebay:<channel>` ($1 = channel).
  await executor.execArgv(['sh', '-c', SWAP_TAG_SH, 'sh', channel]);
  // Pull the new tag and reload the unit up front, AWAITED — a missing/unauthed
  // tag throws here and propagates to the caller instead of being swallowed in
  // a detached async (which left the box reporting the old channel, #2064).
  await executor.execArgv(['podman', 'pull', `${IMAGE}:${channel}`], { timeoutMs: 5 * 60 * 1000 });
  await executor.execArgv(['systemctl', '--user', 'daemon-reload']);
  // Recreate + restart, detached: rm -f tears down the running container (us)
  // so the quadlet recreates it from the new image; the request returns first.
  void (async () => {
    try {
      await executor.execArgv(['podman', 'rm', '-f', 'servicebay']);
      await executor.execArgv(['systemctl', '--user', 'restart', '--no-block', 'servicebay.service']);
      logger.info('channel', `Switched ServiceBay to '${channel}' and triggered container recreate.`);
    } catch (e) {
      logger.error('channel', `Channel switch to '${channel}' failed during recreate/restart: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
