/**
 * POST /api/system/stacks/[name]/wipe (#634 / Phase 5B)
 *
 * One-button stack-level wipe. Per the user-locked design:
 *   1. For each child template (reverse install order):
 *      - Capture the variables snapshot from `config.installManifest` /
 *        `installedSecrets` so the uninstall event can carry the same
 *        `lastKnownVariables` the install event saw.
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
  // `tokenScope: 'destroy'` lets the sb-tui desired-state install panel
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

    // Snapshot variables once — every per-template `feature.uninstalled`
    // event carries the same map so handlers (especially NPM, which
    // reconstructs `<sub>.<PUBLIC_DOMAIN>`) see consistent context.
    const config = await getConfig();
    const lastKnownVariables: StackVariable[] = buildLastKnownVariables(config);

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
        await ServiceManager.deleteService(nodeName, template);
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

/**
 * Reconstruct the install-time variable map from persisted config.
 * Combines `installedSecrets` (#615/#622) with the operator-visible
 * `installManifest.credentials` entries and the `templateSettings`
 * globals. Not exhaustive — non-secret per-template variables that
 * were never persisted aren't recoverable, but the handlers' uninstall
 * paths only need the values they used at install time (subdomain
 * names, PUBLIC_DOMAIN), all of which are persisted.
 */
function buildLastKnownVariables(config: Awaited<ReturnType<typeof getConfig>>): StackVariable[] {
  const out: StackVariable[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string) => {
    if (seen.has(name) || !value) return;
    seen.add(name);
    out.push({ name, value });
  };

  for (const [k, v] of Object.entries(config.templateSettings ?? {})) {
    if (typeof v === 'string') push(k, v);
  }
  if (config.reverseProxy?.publicDomain) push('PUBLIC_DOMAIN', config.reverseProxy.publicDomain);
  for (const entry of config.installedSecrets ?? []) {
    push(entry.varName, entry.password);
  }
  return out;
}
