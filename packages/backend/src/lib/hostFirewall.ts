/**
 * Host-level packet filtering for service ports that must stay reachable
 * **on-box** but not from the LAN (#2388).
 *
 * ## Why this exists at all
 *
 * Fedora CoreOS ships with no firewall enabled (`firewalld` isn't even
 * installed; `nftables.service` is present but disabled with an empty
 * `/etc/sysconfig/nftables.conf`). So any port a `hostNetwork: true` pod
 * binds on `0.0.0.0` is reachable from every device on the LAN.
 *
 * For most such ports the fix is to bind loopback instead — that's what
 * #2357 (radicale's `hostIP: 127.0.0.1`) and #2380 (LLDAP's
 * `LLDAP_HTTP_HOST=127.0.0.1`) did, and a template-level bind is always
 * the better answer when it's available. **This module is for the ports
 * where it isn't.** LLDAP's raw LDAP port is the motivating case:
 * isolated (non-`hostNetwork`) pods reach it through
 * `host.containers.internal`, which rootless podman/pasta maps to the
 * host's **LAN** address rather than loopback (`--map-guest-addr`), so a
 * loopback bind silently breaks radicale's `ldap_uri` and Jellyfin's
 * LDAP-Auth plugin (the #817/#837 constraint).
 *
 * ## Why matching on the input interface is the right discriminator
 *
 * Measured on the live box (pasta 2026-xx, podman 5.x, rootless):
 *
 *   - A pod connects to `host.containers.internal:3890`. pasta terminates
 *     that in the host netns and re-opens it as
 *     `192.168.178.100:33620 -> 192.168.178.100:3890`. Because the
 *     destination is one of the host's **own** addresses, the kernel
 *     routes it over loopback (`ip route get <own-lan-ip>` ⇒
 *     `local … dev lo`), which the socket confirms: `pmtu 65535`,
 *     `advmss 65483`. So it arrives at the `input` hook with `iif lo`.
 *   - A real LAN device's SYN arrives on the physical NIC (`iif eno1`).
 *
 * Source-address matching would *not* work here: the pasta path's source
 * address IS the host's LAN address, indistinguishable by prefix from a
 * neighbour on the same /24. The input interface separates them cleanly,
 * is family-agnostic (LLDAP listens on `*:3890`, i.e. dual-stack, and the
 * NIC has an IPv6 link-local address a LAN device could use), and doesn't
 * break when the box's DHCP lease changes.
 *
 * ## Safety properties (this touches the host firewall — read before editing)
 *
 *  1. **Own table, never the shared ruleset.** Everything lives in
 *     `table inet servicebay_lanblock`. The rendered file never contains
 *     `flush ruleset` — that would wipe podman/netavark's own tables
 *     (which is exactly what the distro's `nftables.service`
 *     `ExecStop=nft flush ruleset` does, and why we do NOT reuse that
 *     unit).
 *  2. **Structurally port-scoped.** The base chain has exactly ONE rule,
 *     and it matches `tcp dport @<set>` — the set holds only ports a
 *     template explicitly declared. A packet for any other port cannot
 *     reach a `drop`, no matter what the gate chain says.
 *  3. **Never-filter list.** {@link NEVER_FILTER_PORTS} refuses SSH, the
 *     reverse proxy and ServiceBay's own ports outright, so a
 *     mis-templated variable can't lock the operator out of the box.
 *  4. **Validated before it goes live.** The rendered ruleset is checked
 *     with `nft -c -f` (dry run, commits nothing) before it is installed
 *     or loaded.
 *  5. **One-line rollback**, printed into the rendered file itself:
 *     `sudo nft delete table inet servicebay_lanblock`. Works even if
 *     ServiceBay is down; `systemctl stop servicebay-host-firewall`
 *     does the same via `ExecStop`.
 *
 * ## Shape
 *
 * Same render-then-idempotently-apply shape as `updateWindow.ts`: pure
 * render functions, a reconcile that writes the full desired state (so
 * re-running can't duplicate or strand rules), and a remove path that
 * tolerates "already gone" at every step.
 */
import type { Executor } from './interfaces';
import { logger } from './logger';

/** Our own nft table. Nothing outside it is ever touched. */
export const NFT_TABLE = 'servicebay_lanblock';
/** Named set holding the declared ports — the only thing the base chain matches. */
const PORT_SET = 'on_box_only_ports';
/** Regular chain the base chain jumps to once a packet matched a declared port. */
const GATE_CHAIN = 'on_box_gate';

const NFT_DIR = '/etc/servicebay';
const NFT_PATH = `${NFT_DIR}/host-firewall.nft`;
const NFT_TMP = '/tmp/servicebay-host-firewall.nft';

export const UNIT_NAME = 'servicebay-host-firewall.service';
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}`;
const UNIT_TMP = '/tmp/servicebay-host-firewall.service';

/** Used when `command -v nft` can't be resolved. Correct on Fedora/RHEL. */
const DEFAULT_NFT_BIN = '/usr/sbin/nft';

/**
 * Ports we refuse to filter no matter what a template declares.
 *
 * A wrong entry here is a lockout, not a bug report: 22/2222 is SSH (the
 * only way back into the box), 80/443 is the reverse proxy plus ACME's
 * HTTP-01 challenge, and 3000/3001 are ServiceBay's own UI and agent.
 * A template asking to LAN-block one of these is a mistake by
 * definition, so we drop the request and log loudly rather than obey it.
 */
export const NEVER_FILTER_PORTS: readonly number[] = [22, 80, 443, 2222, 3000, 3001];

/** The subset of a template's `variables.json` entry this module reads. */
export interface PortVarDeclaration {
  blockLanAccess?: boolean;
  default?: string;
}

export interface LanBlockInput {
  /** Templates currently installed, in any order. */
  installedTemplates: string[];
  /** template name → its `variables.json` (name → meta). */
  declarations: Record<string, Record<string, PortVarDeclaration> | null | undefined>;
  /** Resolved variable values (config.templateSettings + the install event's vars). */
  values: Record<string, string | undefined>;
}

export interface LanBlockPlan {
  /** Ports to refuse LAN access to, de-duplicated and ascending. */
  ports: number[];
  /** Human-readable reasons a declared port was NOT filtered. Log these. */
  skipped: string[];
}

/**
 * Walk every installed template's declared variables and collect the
 * ports flagged `blockLanAccess`. Pure — all I/O is the caller's.
 *
 * A port is only collected when its value is unambiguous: `values` first
 * (what the operator actually configured), then the declared `default`.
 * Anything that isn't a plain integer in 1‥65535, or that lands on
 * {@link NEVER_FILTER_PORTS}, is skipped with a reason instead of being
 * guessed at — a firewall rule built from a half-parsed value is worse
 * than no rule.
 */
export function collectLanBlockedPorts(input: LanBlockInput): LanBlockPlan {
  const ports = new Set<number>();
  const skipped: string[] = [];

  for (const template of input.installedTemplates) {
    const declared = input.declarations[template];
    if (!declared) continue;
    for (const [varName, meta] of Object.entries(declared)) {
      if (!meta || meta.blockLanAccess !== true) continue;
      const raw = input.values[varName] ?? meta.default;
      if (raw === undefined || !/^\d+$/.test(raw.trim())) {
        skipped.push(`${template}.${varName}: not a plain port number (${JSON.stringify(raw)})`);
        continue;
      }
      const port = Number(raw.trim());
      if (port < 1 || port > 65535) {
        skipped.push(`${template}.${varName}: port ${port} out of range`);
        continue;
      }
      if (NEVER_FILTER_PORTS.includes(port)) {
        skipped.push(
          `${template}.${varName}: refusing to LAN-block port ${port} — it is on the never-filter list ` +
            `(SSH / reverse proxy / ServiceBay itself); blocking it would lock the operator out`,
        );
        continue;
      }
      ports.add(port);
    }
  }

  return { ports: [...ports].sort((a, b) => a - b), skipped };
}

/**
 * Static header of the rendered file. Deliberately verbose: this text
 * lands in `/etc` on the box, where it is the only documentation an
 * operator debugging a refused connection (or needing the rollback) has
 * in front of them.
 */
const NFT_FILE_HEADER = `#!/usr/sbin/nft -f
# Managed by ServiceBay — regenerated on every template install/uninstall.
# Hand edits are overwritten. See packages/backend/src/lib/hostFirewall.ts.
#
# Purpose (#2388): these ports are needed ON the box (loopback, and the
# pasta-proxied path isolated pods use via host.containers.internal, which
# lands on lo because the destination is one of the host's own addresses)
# but must not answer devices on the LAN.
#
# EMERGENCY ROLLBACK — one line, bounded blast radius, works with
# ServiceBay down:
#
#   sudo nft delete table inet ${NFT_TABLE}
#
# This file NEVER flushes the ruleset: podman/netavark keep their own
# tables in the same namespace and flushing would break container
# networking.
`;

/**
 * Render the nft script. Loaded verbatim by the systemd unit at boot and
 * by `reconcileHostFirewall` at install time.
 *
 * The `add table` / `delete table` / `add table {…}` prelude is nft's
 * documented atomic-replacement idiom: `nft -f` runs the whole file as
 * ONE transaction, so re-applying can never duplicate a rule and can
 * never leave the host half-filtered. `add table` is a no-op when the
 * table already exists, which is what makes the `delete` safe on a first
 * run.
 */
export function renderNftRuleset(ports: number[]): string {
  if (ports.length === 0) {
    throw new Error('renderNftRuleset: refusing to render an empty ruleset — remove the table instead');
  }
  return `${NFT_FILE_HEADER}
add table inet ${NFT_TABLE}
delete table inet ${NFT_TABLE}

table inet ${NFT_TABLE} {
	set ${PORT_SET} {
		type inet_service
		comment "ports a template declared blockLanAccess on"
		elements = { ${ports.join(', ')} }
	}

	# Reached only for a packet whose destination port is in the set
	# above. Declared before the base chain so the jump target always
	# exists at load time.
	chain ${GATE_CHAIN} {
		# On-box origins. \`lo\` covers loopback clients AND the
		# pasta-proxied pod path (measured: pasta re-opens the
		# connection to the host's own LAN address, which the kernel
		# routes over lo). The bridge names cover a container that
		# reaches the port over podman's own bridge instead — also
		# on-box, and blocking it would be theatre since such a
		# container can already reach every other host port.
		iifname "lo" accept
		iifname "podman*" accept
		iifname "cni-podman*" accept
		iifname "veth*" accept
		# Anything else arrived on a physical/LAN interface.
		counter drop
	}

	chain input {
		type filter hook input priority filter; policy accept;
		# The ONLY rule in the hooked chain, and it is port-scoped:
		# no packet for an undeclared port can reach a drop verdict.
		tcp dport @${PORT_SET} jump ${GATE_CHAIN}
	}
}
`;
}

/**
 * Render the boot-persistence unit.
 *
 * Deliberately NOT the distro's `nftables.service`: that one owns
 * `/etc/sysconfig/nftables.conf` and its `ExecStop` is
 * `nft flush ruleset`, which would take podman/netavark's tables down
 * with it. Ours loads one file and, on stop, deletes exactly one table —
 * which doubles as the rollback handle (`systemctl stop`).
 */
export function renderUnit(nftBin: string): string {
  return `# Managed by ServiceBay — do not edit (regenerated on install/uninstall).
[Unit]
Description=ServiceBay host firewall — refuse LAN access to on-box-only service ports
Documentation=https://github.com/mdopp/servicebay/issues/2388
# Standard firewall ordering: rules exist before the network is up, so
# there is no window where a declared port answers the LAN after a reboot.
Wants=network-pre.target
Before=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${nftBin} -f ${NFT_PATH}
# \`-\` prefix: stopping on a host where the table is already gone (manual
# rollback, or a stop after an uninstall) is a success, not a failure.
ExecStop=-${nftBin} delete table inet ${NFT_TABLE}

[Install]
WantedBy=multi-user.target
`;
}

/** Resolve nft's absolute path — systemd needs one and it is not the same on every distro. */
async function resolveNftBin(executor: Executor): Promise<string> {
  try {
    const { stdout } = await executor.execArgv(['sh', '-c', 'command -v nft']);
    const first = stdout.trim().split('\n')[0]?.trim();
    if (first && first.startsWith('/')) return first;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_NFT_BIN;
}

/** Agent writes /tmp (its own user can), then `sudo install` places it root-owned. */
async function installRoot(executor: Executor, tmpPath: string, finalPath: string): Promise<void> {
  const dir = finalPath.slice(0, finalPath.lastIndexOf('/'));
  await executor.execArgv(['sudo', 'mkdir', '-p', dir]);
  await executor.execArgv(['sudo', 'install', '-m', '0644', '-o', 'root', '-g', 'root', tmpPath, finalPath]);
}

async function execIgnoringFailure(executor: Executor, argv: string[], tag: string): Promise<void> {
  try {
    await executor.execArgv(argv);
  } catch (e) {
    logger.warn('HostFirewall', `${tag} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Write the desired state to the host and make it live.
 *
 * Idempotent by construction: the rendered file is the FULL desired
 * state and `nft -f` replaces the table atomically, so re-running after
 * an install, a re-install or a redeploy converges instead of stacking
 * rules. An empty port list means "nothing should be filtered" and routes
 * to {@link removeHostFirewall} — that is also how uninstall cleans up,
 * so no per-port bookkeeping can go stale.
 *
 * Throws on a real failure (bad syntax, sudo refused) so the caller can
 * surface it. Silent success on a security control is the failure mode
 * worth avoiding.
 */
export async function reconcileHostFirewall(executor: Executor, ports: number[]): Promise<void> {
  if (ports.length === 0) {
    await removeHostFirewall(executor);
    return;
  }

  const nftBin = await resolveNftBin(executor);
  const ruleset = renderNftRuleset(ports);

  // Validate BEFORE anything becomes live, and against the tmp copy so a
  // bad render can't even land in /etc (where the boot unit would then
  // fail to load it). `-c` is a dry run: it commits nothing.
  await executor.writeFile(NFT_TMP, ruleset);
  await executor.execArgv(['sudo', nftBin, '-c', '-f', NFT_TMP]);

  await installRoot(executor, NFT_TMP, NFT_PATH);
  await executor.writeFile(UNIT_TMP, renderUnit(nftBin));
  await installRoot(executor, UNIT_TMP, UNIT_PATH);

  await executor.execArgv(['sudo', 'systemctl', 'daemon-reload']);
  await executor.execArgv(['sudo', 'systemctl', 'enable', UNIT_NAME]);
  // `restart`, not `start`: the unit is `RemainAfterExit=yes`, so an
  // already-active unit would ignore `start` and the kernel would keep
  // the previous port set.
  await executor.execArgv(['sudo', 'systemctl', 'restart', UNIT_NAME]);

  logger.info('HostFirewall', `LAN access refused for port(s) ${ports.join(', ')} (table inet ${NFT_TABLE}).`);
}

/**
 * Take the filter down completely: unit stopped + disabled (its
 * `ExecStop` deletes the table), table deleted again as a belt-and-braces
 * step in case the unit was never installed, then both files removed.
 *
 * Every step tolerates "already gone", so this is safe to call on a box
 * that never had the filter — but we probe first so the common
 * nothing-to-do boot doesn't fire four sudo calls for no reason.
 */
export async function removeHostFirewall(executor: Executor): Promise<void> {
  const nftBin = await resolveNftBin(executor);
  const unitPresent = await executor.exists(UNIT_PATH).catch(() => true);
  let tablePresent = false;
  try {
    await executor.execArgv(['sudo', nftBin, 'list', 'table', 'inet', NFT_TABLE]);
    tablePresent = true;
  } catch {
    tablePresent = false;
  }
  if (!unitPresent && !tablePresent) return;

  await execIgnoringFailure(executor, ['sudo', 'systemctl', 'disable', '--now', UNIT_NAME], 'disable unit');
  await execIgnoringFailure(executor, ['sudo', nftBin, 'delete', 'table', 'inet', NFT_TABLE], 'delete table');
  await execIgnoringFailure(executor, ['sudo', 'rm', '-f', UNIT_PATH, NFT_PATH], 'remove files');
  await execIgnoringFailure(executor, ['sudo', 'systemctl', 'daemon-reload'], 'daemon-reload');
  logger.info('HostFirewall', `Host firewall removed (no port declares blockLanAccess).`);
}
