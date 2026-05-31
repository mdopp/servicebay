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
// quadlet path varies by user, so we don't hardcode it. Scripts are FIXED
// strings; the only variable (channel) is passed as a positional ($1), never
// interpolated, so there's no shell-injection surface (and it's enum-checked).
const READ_TAG_SH = 'grep -oE "servicebay:[A-Za-z0-9._-]+" "$HOME/.config/containers/systemd/servicebay.container" | head -1';
const SWAP_TAG_SH = 'sed -i -E "s#(servicebay):[A-Za-z0-9._-]+#\\1:$1#" "$HOME/.config/containers/systemd/servicebay.container"';

export function isChannel(s: string): s is Channel {
  return (CHANNELS as readonly string[]).includes(s);
}

/** The channel the running box is pinned to, read from its quadlet image tag.
 *  Falls back to 'latest' if the line can't be parsed. */
export async function getServicebayChannel(): Promise<string> {
  const { stdout } = await getExecutor('Local').execArgv(['sh', '-c', READ_TAG_SH]);
  return stdout.trim().split(':')[1] || 'latest';
}

/**
 * Re-point the quadlet to `:<channel>`, then pull + restart in the background.
 *
 * The tag swap is awaited (so a bad write surfaces synchronously); the slow
 * pull + the `--no-block` restart run detached so the caller's HTTP response
 * returns before the container is replaced (same pattern as `performUpdate`).
 */
export async function setServicebayChannel(channel: Channel): Promise<void> {
  if (!isChannel(channel)) {
    throw new Error(`Unknown channel "${channel}". Use one of: ${CHANNELS.join(', ')}.`);
  }
  const executor = getExecutor('Local');
  // Swap `…/servicebay:<anything>` → `…/servicebay:<channel>` ($1 = channel).
  await executor.execArgv(['sh', '-c', SWAP_TAG_SH, 'sh', channel]);
  // Pull the new tag, reload the unit, restart non-blocking. Detached so the
  // request can return before ServiceBay (which is serving it) goes down.
  void (async () => {
    try {
      await executor.execArgv(['podman', 'pull', `${IMAGE}:${channel}`], { timeoutMs: 5 * 60 * 1000 });
      await executor.execArgv(['systemctl', '--user', 'daemon-reload']);
      await executor.execArgv(['systemctl', '--user', 'restart', '--no-block', 'servicebay.service']);
      logger.info('channel', `Switched ServiceBay to '${channel}' and triggered restart.`);
    } catch (e) {
      logger.error('channel', `Channel switch to '${channel}' failed during pull/restart: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
