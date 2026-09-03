/**
 * Pre-flight — everything that has to be true before the first pod is
 * deployed (#2742 — split out of `runner.ts`).
 *
 * In order: capture the LAN IP, reconcile orphan container records, refresh
 * the external registries and re-read the template specs from them, topo-sort
 * the selection by dependency, reuse/rotate saved secrets, warn about
 * unrecovered operator values, heal on-disk state that would otherwise lock
 * the new credentials out (`./stateSelfHeal`), and warm the images
 * (`./prePull`).
 *
 * The phase never patches the job: it returns a discriminated result and
 * `runner.ts` turns that into job status. `nothing-selected` and `error` are
 * the two ways an install ends before it starts.
 */
import { formatRegistrySyncLog } from '@/lib/registrySyncState';
import { syncRegistries } from '@/lib/registry';
import { getConfig } from '@/lib/config';
import { reconcileLanIp } from '@/lib/lanIp';
import { getStoreSnapshot } from '@/lib/store/repository';
import { topoSortByDependencies, resolveAlreadyInstalled } from '@/lib/stackInstall/dependencies';
import { parseTemplateTier } from '@/lib/templateTier';
import type { TemplateTier } from '@/lib/templateTier';
import type { JobInputItem } from '../jobStore';
import { log, type DeployContext } from './context';
import { runPrePullPhase } from './prePull';
import { runStateSelfHeal } from './stateSelfHeal';
import {
  buildSentinelUnresolvedError,
  formatSecretRotationLog,
  formatSentinelRestoredLog,
  reuseSavedSecrets,
} from './secretReuse';

/** A selected item once the topo-sort has ordered it. Structurally a
 *  `JobInputItem` plus the resolved dependency list and install tier, so the
 *  deploy loop can hand it straight to the kube-play phase. */
interface SortedInstallItem extends JobInputItem {
  dependencies: string[];
  tier: TemplateTier;
}

export type PreflightResult =
  | { ok: true; selected: SortedInstallItem[] }
  | { ok: false; kind: 'nothing-selected' }
  | { ok: false; kind: 'error'; message: string };

/** Capture / refresh the host's LAN IP synchronously (#660 — S2).
 *
 *  Was previously a 60s boot-deferred setTimeout in server.ts that could
 *  race: when the timer fired before the agent was up, or before
 *  `secret.key` was rewritten on a wipe, `lanIp` never landed in config —
 *  and ~6 diagnose probes (router-DNS, AdGuard rewrites, NPM bootstrap,
 *  OIDC, TLS certs, LE requests) degraded to "no install-time value
 *  recorded yet" with no clear recovery path.
 *
 *  Doing it here, in the runner that already has the agent under
 *  contract, makes the capture deterministic: every install (clean or
 *  not) writes the current outbound LAN IP before the deploy loop fires.
 *  The boot-timer in server.ts is now a drift-detection safety net for
 *  installs that pre-date this change; both call the same idempotent
 *  `reconcileLanIp` (no-op when value matches, history append on drift). */
async function captureLanIp(ctx: DeployContext): Promise<void> {
  const { jobId, input } = ctx;
  try {
    const node = input.node || 'Local';
    const ip = await reconcileLanIp(node);
    if (ip) {
      await log(jobId, `Captured LAN IP: ${ip}`);
      // Expose LAN_IP to template rendering (#817). Templates that drop
      // `hostNetwork` need it for a `hostAliases` entry that resolves
      // the public auth subdomain to the LAN. `LAN_IP` is declared as a
      // global in templates/settings.json (blank default); the wizard
      // can't know the host IP, so the runner fills it in here — every
      // `{{LAN_IP}}` in a rendered template.yml resolves to this value.
      const lanVar = input.variables.find(v => v.name === 'LAN_IP');
      if (lanVar) lanVar.value = ip;
      else input.variables.push({ name: 'LAN_IP', value: ip, global: true });
    } else {
      await log(jobId, '⚠️ Could not detect LAN IP (agent returned no `ip route get` result); diagnose probes that depend on it will degrade.');
    }
  } catch (e) {
    await log(jobId, `⚠️ LAN IP capture failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** #1668 — reconcile orphan container records from podman's preserved DB.
 *
 *  podman's container DB lives on the preserved RAID and survives an
 *  OS-disk reinstall, but the quadlet units that managed those containers
 *  do not. After a wipe-and-reinstall the DB can hold stale records whose
 *  managing `PODMAN_SYSTEMD_UNIT` no longer exists on disk — they surface
 *  as ghost "Unmanaged Bundle" pods.
 *
 *  The reconcile is STRICT: it removes only records that are labelled +
 *  not running + whose managing unit file is absent. A currently running
 *  service (running, quadlet present) is never touched. Best-effort — a
 *  failure here must not block the install. */
async function reconcileOrphans(jobId: string): Promise<void> {
  try {
    const { reconcileOrphanContainers } = await import('../reconcileOrphanContainers');
    const result = await reconcileOrphanContainers(undefined);
    if (result.removed.length > 0) {
      await log(jobId, `Reconciled ${result.removed.length} orphan container record(s) from preserved storage: ${result.removed.join(', ')}`);
    }
    if (result.failed.length > 0) {
      await log(jobId, `⚠️ ${result.failed.length} orphan container(s) could not be removed: ${result.failed.map(f => f.name).join(', ')}`);
    }
  } catch (e) {
    await log(jobId, `(note) orphan-container reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** #1806 — pull external registries BEFORE resolving any template YAML /
 *  post-deploy script, then re-read the specs from what was just pulled.
 *
 *  `syncRegistries()` previously ran only at server startup (server.ts), so an
 *  install fired after a registry commit landed — without an SB container
 *  restart — resolved `getTemplateYaml()` / `getTemplatePostDeployScript()`
 *  from the STALE on-disk clone and silently ran the old script. Syncing at
 *  the start of every deploy makes the install always run the committed
 *  artifacts. Best-effort: `syncRegistries` isolates per-registry errors and
 *  no-ops when no external registries are configured, so a transient fetch
 *  failure must not block the install — it falls back to the existing clone.
 *
 *  #2610 — and say what the sync actually did. The old line claimed
 *  "Refreshed external registries" whether two of two, one of two or none of
 *  them refreshed: an operator who had just committed a template to a registry
 *  this box cannot clone read it as confirmation that their commit was picked
 *  up. The message is now derived from the per-registry outcome and always
 *  carries the denominator. */
async function refreshRegistriesAndSpecs(ctx: DeployContext, checked: JobInputItem[]): Promise<void> {
  const { jobId, input } = ctx;
  try {
    const summary = await syncRegistries();
    for (const line of formatRegistrySyncLog(summary)) {
      await log(jobId, line);
    }
  } catch (e) {
    await log(jobId, `⚠️ Registry refresh failed (${e instanceof Error ? e.message : String(e)}); installing from the existing on-disk clone.`);
  }

  // #2530 — re-resolve the pod specs from the registry we just pulled.
  // `assembleManifest` captured `item.yaml` BEFORE the sync above (a replayed
  // reinstall captured it whenever its manifest was saved), so without this the
  // deploy always renders a template one sync behind — a block added to the
  // template since is silently missing from the rendered pod YAML, with no
  // error and no warning. Refresh in place so the render below uses what the
  // registry actually holds.
  try {
    const { refreshTemplateArtifacts, applyVariableDefaults } = await import('../manifestAssembler');
    const { updated, unresolved } = await refreshTemplateArtifacts(checked, input.templateSource);
    if (updated.length > 0) {
      await log(jobId, `🔄 Re-read ${updated.length} template spec${updated.length === 1 ? '' : 's'} from the refreshed registry — ${updated.join(', ')} changed since this manifest was assembled; deploying the registry version.`);
      // A refreshed spec can reference a variable the manifest never had a
      // value for. Re-apply defaults (fills empty slots only, so nothing the
      // operator set is touched) rather than render the new ref empty.
      const refilled = await applyVariableDefaults(input, input.templateSource);
      input.variables = refilled.variables;
    }
    if (unresolved.length > 0) {
      await log(jobId, `⚠️ Could not re-read the template spec for ${unresolved.join(', ')} from any registry — deploying the spec saved in this manifest, which may be out of date. Check that the template still exists in its registry.`);
    }
  } catch (e) {
    // Never fail the install on the refresh itself — but never let it fail
    // QUIETLY either: a skipped refresh means the specs below are the ones the
    // manifest was assembled with, which is the staleness this guards against.
    await log(jobId, `⚠️ Could not re-read template specs from the registry (${e instanceof Error ? e.message : String(e)}); deploying the specs saved in this manifest, which may be out of date.`);
  }
}

/** Secret reuse (#615) — before any deploy fires, override the wizard's
 *  freshly-generated `type: secret | bcrypt | rsa-private` values with
 *  whatever the saved state has for the same `varName`. Without this,
 *  a clean install that preserves `secrets`/`identity` regenerates
 *  LLDAP_ADMIN_PASSWORD (and friends), the new value mismatches the
 *  still-on-disk LDAP DB hash, and post-deploy.py's seed call gets a
 *  401 from LLDAP.
 *
 *  #1585 — saved secrets are ALWAYS reused. ServiceBay's identity (saved
 *  secret-typed variables, secret.key, tokens) is never wiped by the install
 *  runner under any wipeMode: `wipe-config`/`wipe-all` clear a SERVICE's
 *  config/data, not ServiceBay's own identity.
 *
 *  #2574 — reuse fills a GAP; it does not overrule INPUT. A variable the
 *  caller supplied for this run (`explicit`) keeps its supplied value. Before
 *  this, the reuse put the old secret back on every path, the install still
 *  reported success, and the only trace was the cheerful "Reusing …" line —
 *  so a service password could not be rotated at all.
 *
 *  Returns the sentinel-unresolved refusal message when the run must stop. */
async function applySavedSecrets(ctx: DeployContext): Promise<string | null> {
  const { jobId, input, reusedSecretNames } = ctx;
  try {
    const { getConfig: readConfig } = await import('@/lib/config');
    const { loadSavedSecrets } = await import('../savedSecrets');
    const { REDACTION_SENTINEL } = await import('@/lib/mcp/redact');
    const saved = loadSavedSecrets(await readConfig());
    const { overrideNames, sentinelRestored, sentinelUnresolved, rotatedNames } =
      reuseSavedSecrets(input.variables, saved, reusedSecretNames, REDACTION_SENTINEL);
    if (rotatedNames.length > 0) {
      await log(jobId, formatSecretRotationLog(rotatedNames));
    }
    if (sentinelRestored.length > 0) {
      await log(jobId, formatSentinelRestoredLog(sentinelRestored, REDACTION_SENTINEL));
    }
    if (sentinelUnresolved.length > 0) {
      const msg = buildSentinelUnresolvedError(sentinelUnresolved, REDACTION_SENTINEL);
      await log(jobId, `❌ ${msg}`);
      return msg;
    }
    if (overrideNames.length > 0) {
      await log(jobId, `🔑 Reusing ${overrideNames.length} saved secret${overrideNames.length === 1 ? '' : 's'} from before the reset (${overrideNames.slice(0, 4).join(', ')}${overrideNames.length > 4 ? `, +${overrideNames.length - 4} more` : ''}) so services with preserved data volumes can still authenticate.`);
    }
  } catch (e) {
    // Best-effort — a missing config or decryption failure shouldn't
    // block the install. The wizard's regenerated values still flow
    // through; we just lose the reuse benefit for this run.
    await log(jobId, `(note) could not load saved secrets: ${e instanceof Error ? e.message : String(e)}. Continuing with wizard-generated values.`);
  }
  return null;
}

/** #2531 — the loud backstop for the non-secret twin of the reuse above.
 *  `applyVariableDefaults` restores operator-set values at the install entry
 *  point, so a variable that STILL arrives empty despite having a saved value
 *  means the restore did not happen (config unreadable, the record lost). That
 *  is a value being destroyed, not a field left blank — it gets its own line
 *  instead of being folded into the generic #1318 "rendered empty" warning. */
async function warnUnrecoveredVariables(ctx: DeployContext): Promise<void> {
  try {
    const { loadSavedVariables, findUnrecoveredVariables, buildUnrecoveredVariablesWarning } =
      await import('../savedVariables');
    const lost = findUnrecoveredVariables(ctx.input.variables, loadSavedVariables(await getConfig()));
    if (lost.length > 0) await log(ctx.jobId, buildUnrecoveredVariablesWarning(lost));
  } catch {
    // Best-effort: a config read failure must not block the install.
  }
}

/**
 * Run the whole pre-flight. On `ok: true` the returned `selected` list is the
 * dependency-ordered set the deploy loop walks.
 */
export async function runPreflightPhase(ctx: DeployContext): Promise<PreflightResult> {
  const { jobId, input } = ctx;

  await captureLanIp(ctx);
  await reconcileOrphans(jobId);

  const checked = input.items.filter(i => i.checked);
  if (checked.length === 0) {
    await log(jobId, '⚠️ No services selected to install — aborting.');
    return { ok: false, kind: 'nothing-selected' };
  }

  await refreshRegistriesAndSpecs(ctx, checked);

  // Topo-sort by install-time dependencies. We also tag each item
  // with its `servicebay.tier` so the sort adds an implicit edge from
  // every feature to every infrastructure item — guaranteeing the
  // whole infra block (nginx, auth, adguard, …) is fully deployed
  // before any feature can register against it (#796). Without that
  // gate, an unrelated feature with no declared deps races nginx and ends
  // up registering NPM proxy hosts that the late-running NPM credentials
  // self-heal then wipes.
  // A dependency is satisfied by anything already deployed on the node, not
  // just by items re-selected in this batch. Fold the live twin's service
  // names in (node-scoped) so installing e.g. `hermes` isn't wrongly blocked
  // on `home-assistant` when HA is already running but wasn't re-checked.
  const installNode = input.node || 'Local';
  const deployedOnNode = (getStoreSnapshot().nodes?.[installNode]?.services ?? []).map(s => s.name);
  const sortResult = topoSortByDependencies<SortedInstallItem>(
    checked.map(i => ({
      name: i.name,
      checked: i.checked,
      alreadyInstalled: i.alreadyInstalled,
      yaml: i.yaml,
      configFiles: i.configFiles,
      dependencies: i.dependencies ?? [],
      tier: i.yaml ? parseTemplateTier(i.yaml) : 'feature',
    })),
    { alreadyInstalled: resolveAlreadyInstalled(input.items, deployedOnNode) },
  );
  if (!sortResult.ok) {
    const msg = sortResult.reason === 'missing'
      ? `Cannot install ${sortResult.item}: it depends on ${sortResult.missing.join(', ')}, which ${sortResult.missing.length === 1 ? 'is' : 'are'} not selected. Go back and check ${sortResult.missing.length === 1 ? 'that template' : 'those templates'}, or unselect ${sortResult.item}.`
      : `Templates form a dependency cycle (${sortResult.involved.join(' ↔ ')}). This is a template-authoring bug — please report it.`;
    await log(jobId, `❌ ${msg}`);
    return { ok: false, kind: 'error', message: msg };
  }
  const selected = sortResult.ordered;
  const sortedNames = selected.map(s => s.name).join(' → ');
  const checkedNames = checked.map(c => c.name).join(' → ');
  if (sortedNames !== checkedNames) {
    await log(jobId, `Install order (by dependencies): ${sortedNames}`);
  }

  const sentinelRefusal = await applySavedSecrets(ctx);
  if (sentinelRefusal) return { ok: false, kind: 'error', message: sentinelRefusal };
  await warnUnrecoveredVariables(ctx);

  await runStateSelfHeal(jobId, input, selected, ctx.reusedSecretNames);
  await runPrePullPhase(jobId, input, selected);

  return { ok: true, selected };
}
