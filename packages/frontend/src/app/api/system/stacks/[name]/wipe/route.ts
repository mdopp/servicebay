/**
 * POST /api/system/stacks/[name]/wipe (#634 / Phase 5B)
 *
 * One-button stack-level wipe. Per the user-locked design:
 *   1. For each child template (reverse install order):
 *      - Reconstruct that template's install-time variables (declarations
 *        from `variables.json`, values through the shared read-path
 *        resolver + `installedSecrets`) so the uninstall events carry the
 *        `meta` the NPM/AdGuard handlers filter on — see
 *        `capabilities/serviceLifecycleEvents.ts`.
 *      - Emit `feature.uninstalling` → handlers prep for removal.
 *      - Stop + delete the service (via ServiceManager.deleteService —
 *        removes the Quadlet unit + stops the pod).
 *      - Emit `feature.uninstalled` → handlers clean cross-service
 *        registrations (Authelia OIDC client, NPM proxy host, AdGuard
 *        rewrite, credentials manifest entry).
 *   2. Remove the stack's data dir at `<DATA_DIR>/<template>/` for each
 *      child.
 *
 * Confirmation token: `WIPE-<stack>` (e.g. `WIPE-immich`) so the
 * operator can't accidentally type the wrong dialog's token.
 *
 * Atomic-wipe stacks (`tier: core` with `lifecycle: atomic-wipe`) refuse
 * this endpoint — the basic stack is wipe-via-FACTORY-RESET only. The
 * caller can use `/api/system/factory-reset` for that path.
 */
import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getStackManifest } from '@/lib/registry';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { getNodeTwins } from '@/lib/store/repository';
import { getConfig } from '@/lib/config';
import { getCapabilityBus } from '@/lib/capabilities/bus';
import { reconstructTemplateVariables } from '@/lib/capabilities/serviceLifecycleEvents';
import { logger } from '@/lib/logger';
import type { StackVariable } from '@/lib/stackInstall/types';

export const dynamic = 'force-dynamic';

interface WipeResult {
  ok: boolean;
  deleted: string[];
  failed: { template: string; error: string }[];
  capabilityFailures: { template: string; handler: string; message: string }[];
  wipedPaths: string[];
}

export const POST = withApiHandlerParams<undefined, undefined, { name: string }>(
  // `tokenScope: 'destroy'` lets the sb desired-state install panel
  // uninstall a feature stack with its scoped `sb_` token. The handler
  // still hard-refuses atomic-wipe/core stacks below, and the body must
  // carry the WIPE-<name> confirmation, so the token can't cause a
  // surprise teardown of anything load-bearing.
  { tokenScope: 'destroy' },
  async ({ request, params }) => {
  try {
    const { name } = params;
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const expected = `WIPE-${name}`;
    if (body.confirm !== expected) {
      return NextResponse.json(
        { error: `Confirmation required. Pass {"confirm": "${expected}"} in body.` },
        { status: 400 },
      );
    }

    const manifest = await getStackManifest(name);
    if (!manifest) {
      return NextResponse.json({ error: `Stack \`${name}\` has no manifest.` }, { status: 404 });
    }
    if (manifest.lifecycle === 'atomic-wipe') {
      return NextResponse.json(
        {
          error: `Stack \`${name}\` is atomic-wipe — use Settings → System → Factory Reset instead.`,
        },
        { status: 400 },
      );
    }

    const nodeName = (typeof body.node === 'string' && body.node) || Object.keys(getNodeTwins())[0] || 'Local';

    const config = await getConfig();

    // Compute data-dir paths up front so we can refuse if DATA_DIR
    // points somewhere unsafe.
    const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data/stacks';
    const safeRe = /^\/(mnt|var\/mnt|opt|srv|home)\/[^.][^\s]+/;
    if (!safeRe.test(dataDir) || dataDir.length < 8) {
      return NextResponse.json(
        { error: `Refusing to wipe DATA_DIR="${dataDir}" — outside the safe path whitelist` },
        { status: 500 },
      );
    }

    const bus = getCapabilityBus();
    const result: WipeResult = {
      ok: true,
      deleted: [],
      failed: [],
      capabilityFailures: [],
      wipedPaths: [],
    };

    // Wipe in reverse-install order — sibling templates that depend on
    // this one stop first. The stack manifest's `templates` array is
    // already topologically ordered (Phase 2A's lint enforces it).
    const reverseOrder = [...manifest.templates].reverse();

    for (const template of reverseOrder) {
      // Per-template reconstruction (#2541). The old shared
      // `buildLastKnownVariables` snapshot carried no `meta`, so
      // `buildProxyHosts` and `rewriteNamesFor` — both of which filter on
      // `meta.type === 'subdomain'` — matched nothing and the NPM + AdGuard
      // cleanup were silent no-ops. Reconstructing per template is also the
      // only way `meta.templateName` (the ownership key) can be right.
      const lastKnownVariables: StackVariable[] = await reconstructTemplateVariables(template);

      // Fire `feature.uninstalling` first so handlers can capture any
      // state the unit holds. Failures here are logged but non-fatal.
      try {
        const prep = await bus.emit({ kind: 'feature.uninstalling', template, lastKnownVariables });
        for (const f of prep.failures) {
          if (!f.result.ok) {
            result.capabilityFailures.push({ template, handler: f.handler, message: f.result.message });
          }
        }
      } catch (e) {
        logger.warn('StackWipe', `feature.uninstalling for ${template} threw: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Stop + delete the unit. ServiceManager handles both the
      // systemctl stop and the .kube file deletion.
      try {
        // This route owns the events (it reports per-handler failures back
        // to the caller), so the delete path must not fire them again.
        await ServiceManager.deleteService(nodeName, template, { emitCapabilityEvents: false });
        result.deleted.push(template);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.failed.push({ template, error: msg });
        result.ok = false;
        logger.warn('StackWipe', `Failed to delete service ${template}: ${msg}`);
        // Even if delete failed, continue with the rest of the stack —
        // partial wipe is better than half-stopped.
      }

      // Fire `feature.uninstalled` so handlers clean cross-service
      // registrations.
      try {
        const post = await bus.emit({ kind: 'feature.uninstalled', template, lastKnownVariables });
        for (const f of post.failures) {
          if (!f.result.ok) {
            result.capabilityFailures.push({ template, handler: f.handler, message: f.result.message });
          }
        }
      } catch (e) {
        logger.warn('StackWipe', `feature.uninstalled for ${template} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Remove each template's data dir. Done after every unit has stopped
    // so we don't yank disk out from under a still-writing process.
    try {
      const agent = await agentManager.ensureAgent(nodeName);
      for (const template of reverseOrder) {
        const dirPath = `${dataDir}/${template}`;
        try {
          await agent.sendCommand('exec', { command: `rm -rf ${JSON.stringify(dirPath)}` });
          result.wipedPaths.push(dirPath);
        } catch (e) {
          logger.warn('StackWipe', `Failed to wipe ${dirPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      logger.warn('StackWipe', `agent unreachable, skipped data-dir wipe: ${e instanceof Error ? e.message : String(e)}`);
    }

    return NextResponse.json(result);
  } catch (e) {
    return apiError(e, { tag: 'api:system:stacks:wipe', status: 500 });
  }
});
