/**
 * DELETE /api/system/authelia/oidc-clients/[client_id]
 *
 * Removes a single OIDC client from Authelia's configuration.yml and
 * restarts the auth pod so Authelia reloads the new client list.
 *
 * Called by the Authelia capability handler (#630) on
 * `feature.uninstalled`. Returns 404 if Authelia isn't deployed AND the
 * client wasn't found — uninstall paths treat both as "already gone."
 *
 * Mirrors the discovery + IO pattern in the sibling POST route — at
 * some point both routes should share a small helper, but the
 * duplication is small enough today (yaml load/dump + restart) that
 * factoring it out wasn't worth the indirection for one new endpoint.
 */
import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { withApiHandlerParams } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { agentManager } from '@/lib/agent/manager';
import yaml from 'js-yaml';

export const dynamic = 'force-dynamic';

interface AutheliaClient { client_id?: string }
interface AutheliaConfig {
  identity_providers?: {
    oidc?: {
      clients?: AutheliaClient[];
    };
  };
}

export const DELETE = withApiHandlerParams<undefined, undefined, { client_id: string }>(
  {},
  async ({ params }) => {
  try {
    const { client_id: clientId } = params;
    if (!clientId) {
      return NextResponse.json({ error: 'client_id required' }, { status: 400 });
    }

    // Locate Authelia by walking the digital twin and looking up the
    // merged auth-pod manifest on each node — same path the POST uses.
    const twin = DigitalTwinStore.getInstance();
    const nodes = Object.keys(twin.nodes);
    let autheliaNode: string | null = null;
    let autheliaYaml = '';
    for (const nodeName of nodes) {
      try {
        const files = await ServiceManager.getServiceFiles(nodeName, 'auth');
        if (files.yamlContent) {
          autheliaNode = nodeName;
          autheliaYaml = files.yamlContent;
          break;
        }
      } catch { /* not on this node */ }
    }
    if (!autheliaNode || !autheliaYaml) {
      return NextResponse.json({ error: 'Authelia is not deployed' }, { status: 404 });
    }

    // Find the config volume hostPath.
    const docs = yaml.loadAll(autheliaYaml) as Array<{ spec?: { volumes?: Array<{ name?: string; hostPath?: { path?: string } }> } }>;
    let configPath = '';
    for (const doc of docs) {
      const volumes = doc?.spec?.volumes;
      if (!Array.isArray(volumes)) continue;
      for (const vol of volumes) {
        if (vol.name?.includes('config') && vol.hostPath?.path) {
          configPath = vol.hostPath.path;
          break;
        }
      }
      if (configPath) break;
    }
    if (!configPath) {
      return NextResponse.json({ error: 'Could not find Authelia config volume' }, { status: 500 });
    }

    const configFilePath = `${configPath}/configuration.yml`;
    const agent = await agentManager.ensureAgent(autheliaNode);
    const readRes = await agent.sendCommand('read_file', { path: configFilePath });
    const currentConfig: string = readRes.content || readRes.stdout || '';
    if (!currentConfig) {
      return NextResponse.json({ error: 'Could not read Authelia configuration' }, { status: 500 });
    }

    const autheliaConfig = (yaml.load(currentConfig) ?? {}) as AutheliaConfig;
    const existingClients: AutheliaClient[] = autheliaConfig.identity_providers?.oidc?.clients ?? [];
    const idx = existingClients.findIndex(c => c.client_id === clientId);
    if (idx < 0) {
      // Already gone — return 404 so uninstall paths can treat it as
      // success and idempotent re-fires don't accumulate spurious work.
      return NextResponse.json({ removed: false, reason: 'not_found' }, { status: 404 });
    }
    existingClients.splice(idx, 1);

    // Preserve the surrounding shape (other identity_providers fields
    // stay intact) — only the `clients` array changes.
    if (!autheliaConfig.identity_providers) autheliaConfig.identity_providers = {};
    if (!autheliaConfig.identity_providers.oidc) autheliaConfig.identity_providers.oidc = {};
    autheliaConfig.identity_providers.oidc.clients = existingClients;

    const newConfig = yaml.dump(autheliaConfig, { lineWidth: -1, quotingType: "'", forceQuotes: false });
    await agent.sendCommand('write_file', { path: configFilePath, content: newConfig });

    // Restart the merged auth pod so Authelia rereads the client list.
    // Non-fatal — config is durable; restart can be done manually.
    try {
      await ServiceManager.restartService(autheliaNode, 'auth');
    } catch { /* fine */ }

    return NextResponse.json({ removed: true, client_id: clientId });
  } catch (error) {
    return apiError(error, { tag: 'api:system:authelia:oidc-clients:delete', status: 500 });
  }
});
