/**
 * Kube-play — deploy ONE item to the box (#2742 — split out of `runner.ts`).
 *
 * This is the phase that actually mutates the node: it clears/restores the
 * service's own data per `wipeMode`, asks `./assetTransport` for the rendered
 * pod spec and delivered files, resolves any migration chain via
 * `./migrations`, then POSTs the whole set to `/api/services?stream=1` and
 * streams the route's progress back into the job log.
 *
 * Two ordering rules in here are load-bearing and pinned by
 * `capabilities/servicebayOidcSecret.wiring.test.ts` (#2417):
 *   1. the `servicebay` OIDC rotation pre-flight runs BEFORE the first deploy
 *      attempt, so a refusal leaves the box untouched;
 *   2. the reconcile of ServiceBay's own copy of that secret runs only AFTER
 *      a deploy succeeded, so a failed deploy can never strand the pair.
 */
import type { JobInputItem } from '../jobStore';
import {
  loadPostDeployScript,
  preserveAutheliaOidcClients,
  buildPostDeployEnv,
  runAssetTransportPhase,
} from './assetTransport';
import { apiFetch, isJobAborted, log, patchJob, type DeployContext } from './context';
import { runMigrationsPhase } from './migrations';

const MAX_DEPLOY_ATTEMPTS = 3;
const DEPLOY_BACKOFF_MS = [0, 1000, 4000];

/** Deploy a single template via /api/services?stream=1. Returns true on
 *  successful deploy, false on terminal failure. Retries transient
 *  failures up to MAX_DEPLOY_ATTEMPTS. */
export async function runKubePlayPhase(ctx: DeployContext, item: JobInputItem): Promise<boolean> {
  const { jobId, input } = ctx;
  if (!item.yaml) {
    // #2601 — this used to return false with no log at all: the job then ran
    // to `done` having deployed nothing, which is indistinguishable from a
    // successful install. Say it instead.
    await log(jobId, `❌ ${item.name} carries no template spec in this manifest — nothing was deployed for it.`);
    return false;
  }

  await log(jobId, `Installing ${item.name}...`);
  await patchJob(jobId, {
    progress: {
      currentItem: item.name,
      deployedNames: ctx.deployed.map(d => d.name),
      totalCount: input.items.filter(i => i.checked).length,
    },
  });

  // #1585 — per-service wipe under the new wipeMode model. wipe-config clears
  // only this service's CONFIG paths (keeps DATA); wipe-all clears CONFIG+DATA.
  // Acts ONLY on this service's data dir — never a system-wide nuke. No-op for
  // `install` (or absent mode). Best-effort; never throws.
  // The service plus any sibling-store services that ride its deploy (#1594 —
  // e.g. home-assistant carries `home-assistant-zwave`, the zwave-js key store
  // in a sibling dir with no template name of its own).
  const { getSiblingBackupServices } = await import('@servicebay/backup-manifest');
  const backupServices = [item.name, ...getSiblingBackupServices(item.name)];

  {
    const { wipeServiceForReinstall } = await import('@/lib/externalBackup/restore');
    for (const svc of backupServices) {
      await wipeServiceForReinstall(
        svc,
        { wipeMode: input.wipeMode, node: input.node },
        line => log(jobId, line),
      );
    }
  }

  // #1218 entry point 1 — restore this service's config from the NAS before its
  // pod starts. On `install` it restores only into an empty data dir (config
  // missing); on `wipe-config`/`wipe-all` the CONFIG paths were just cleared, so
  // it force-restores them over the kept DATA. No-op otherwise; never throws
  // (see autoRestoreServiceOnReinstall). Mirrors the cert-archive restore.
  {
    const { autoRestoreServiceOnReinstall } = await import('@/lib/externalBackup/restore');
    for (const svc of backupServices) {
      await autoRestoreServiceOnReinstall(
        svc,
        { wipeMode: input.wipeMode, node: input.node },
        line => log(jobId, line),
      );
    }
  }

  // Render the pod spec + the delivered file set, running every
  // missing-variable / redaction-sentinel guard on the way (throws on a
  // hard-fail; the deploy loop turns that into the job's terminal error).
  const { yamlContent, kubeContent, extraFiles } =
    await runAssetTransportPhase(jobId, input, { ...item, yaml: item.yaml });

  // #1724 — the auth template's `configuration.yml.mustache` only ships its own
  // baked-in `servicebay` OIDC client. Other SSO stacks register their clients
  // incrementally into the on-disk config; a fresh render would OVERWRITE and
  // DROP them, breaking every other service's SSO with `invalid_client` until
  // each stack is individually redeployed. Before writing the auth config, read
  // the current on-disk `configuration.yml` and merge back any clients the
  // fresh render doesn't own — preserving each client's secret (no rotation).
  const existingAutheliaConfig = await preserveAutheliaOidcClients(jobId, input.node, extraFiles);

  // #2417 — the `servicebay` OIDC client (the admin panel's own "Login with
  // Authelia") is the ONE client whose secret this deploy is allowed to
  // rotate: it is owned by the fresh render, so the upgrade off the old
  // hardcoded literal replaces it. That rotation briefly desynchronises the
  // SSO button, which is only tolerable because the local admin
  // username/password login is a second, non-OIDC door. Assert that door
  // exists BEFORE anything is written — a throw here aborts the deploy with
  // the box untouched, which is strictly safer than rotating the only
  // credential the operator has.
  const { assertServicebayOidcRotationSafe } = await import('@/lib/capabilities/servicebayOidcSecret');
  await assertServicebayOidcRotationSafe(extraFiles, existingAutheliaConfig);

  // Optional per-template post-deploy.py — server runs it after the unit
  // starts; output streams back via `progress` events. Parsed below for
  // `__SB_CREDENTIAL__ {json}` markers. The body ships VERBATIM: values
  // travel via `postDeployEnv` below, not by text substitution (#2415).
  //
  // #2503 — the BODY no longer travels on the wire. The deploy route reads
  // it from the same registry, keyed by the template name + source we send;
  // this call only tells us whether there is a script at all, which decides
  // whether `postDeployEnv` is worth sending.
  const hasPostDeployScript = Boolean(await loadPostDeployScript(item.name, input.templateSource));

  // Migration chain — discover via upgrade-preview; selected steps ship
  // VERBATIM, same contract as post-deploy.py above (#2435).
  const migrations = await runMigrationsPhase(jobId, input, { ...item, yaml: item.yaml });

  const postDeployEnv = await buildPostDeployEnv(input);

  const attemptDeploy = async (): Promise<void> => {
    const query = input.node ? `?node=${input.node}&stream=1` : '?stream=1';
    let res: Response;
    try {
      res = await apiFetch(`/api/services${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name,
          kubeContent,
          yamlContent,
          yamlFileName: `${item.name}.yml`,
          extraFiles,
          // #2703 — this POST carries the template's COMPLETE resolved
          // artifact set (`refreshTemplateArtifacts` → `item.configFiles`),
          // which is what licenses the deploy to delete a path an earlier
          // deploy delivered and this one no longer does. No other caller
          // can say that, so no other caller sends this.
          completeDelivery: true,
          // #2503 — the route resolves post-deploy.py and each migration
          // body from the registry itself; we send the source it should
          // look in plus a by-reference migration chain, never a script.
          templateSource: input.templateSource,
          postDeployEnv: hasPostDeployScript || (migrations && migrations.length > 0) ? postDeployEnv : undefined,
          migrations: migrations?.map(({ filename, fromVersion, toVersion }) => ({ filename, fromVersion, toVersion })),
        }),
      });
    } catch (networkErr) {
      throw new Error(`network: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody.error || `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        const fatal = new Error(msg);
        (fatal as Error & { fatal?: boolean }).fatal = true;
        throw fatal;
      }
      throw new Error(msg);
    }
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'progress') {
            if (typeof evt.message === 'string' && evt.message.startsWith('__SB_CREDENTIAL__ ')) {
              try {
                const captured = JSON.parse(evt.message.slice('__SB_CREDENTIAL__ '.length));
                // Tag with the owning template so the Saved-credentials UI can
                // resolve the loopback `url` to the service's public subdomain
                // (#1626) and per-template uninstall can drop it (#631). The
                // marker itself doesn't carry the name; the deploy loop does.
                if (captured && typeof captured === 'object' && captured.template == null) {
                  captured.template = item.name;
                }
                ctx.scriptCredentials.push(captured);
              } catch { /* malformed marker — drop it */ }
              continue;
            }
            await log(jobId, evt.message);
          } else if (evt.type === 'error') {
            throw new Error(evt.message);
          }
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message !== line.trim()) throw parseErr;
        }
      }
    }
  };

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_DEPLOY_ATTEMPTS; attempt++) {
    if (isJobAborted(jobId)) return false;
    if (DEPLOY_BACKOFF_MS[attempt - 1] > 0) {
      await new Promise(r => setTimeout(r, DEPLOY_BACKOFF_MS[attempt - 1]));
    }
    try {
      await attemptDeploy();
      await log(jobId, attempt > 1
        ? `✅ ${item.name} deployed on attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS}.`
        : `✅ ${item.name} deployed (containers may still be starting in background).`);

      // #2417 — now that Authelia's configuration.yml is actually on disk,
      // copy the `servicebay` client secret it holds into ServiceBay's own
      // `config.oidc.clientSecret`, so the admin panel posts the value the
      // token endpoint will accept. Deliberately AFTER the deploy succeeded:
      // a deploy that died before the config landed must leave the box's
      // existing (consistent) pair alone rather than half-migrate it.
      // No-op for every stack other than `auth`; never throws.
      {
        const { reconcileServicebayOidcSecret } = await import('@/lib/capabilities/servicebayOidcSecret');
        const r = await reconcileServicebayOidcSecret(input.node, extraFiles);
        if (r?.outcome === 'changed') await log(jobId, `🔑 ${r.message}`);
        else if (r?.outcome === 'skipped') await log(jobId, `⚠️ ${r.message}`);
      }
      return true;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if ((lastErr as Error & { fatal?: boolean }).fatal) break;
      if (attempt < MAX_DEPLOY_ATTEMPTS) {
        await log(jobId, `⏳ ${item.name} attempt ${attempt}/${MAX_DEPLOY_ATTEMPTS} failed (${lastErr.message}); retrying in ${DEPLOY_BACKOFF_MS[attempt] / 1000}s…`);
      }
    }
  }
  const tail = (lastErr as Error & { fatal?: boolean })?.fatal
    ? lastErr?.message ?? 'unknown error'
    : `after ${MAX_DEPLOY_ATTEMPTS} attempt(s): ${lastErr?.message ?? 'unknown error'}`;
  await log(jobId, `❌ Failed to install ${item.name} ${tail}`);
  return false;
}
