import { NextRequest, NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { getTemplateVariables } from '@/lib/registry';
import crypto from 'crypto';
import yaml from 'js-yaml';

function generateSecret(length = 32): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

interface OidcClientsRequest {
  /** Template names to extract OIDC client definitions from */
  templates: { name: string; source?: string }[];
  /** Variable values (needs PUBLIC_DOMAIN and *_SUBDOMAIN values) */
  variables: Record<string, string>;
}

/**
 * POST: Auto-register OIDC clients for deployed templates.
 * Looks up each template's variables.json for oidcClient definitions,
 * builds client configs, and appends them to Authelia's configuration.yml.
 */
export async function POST(request: NextRequest) {
  try {
    const body: OidcClientsRequest = await request.json();
    if (!body.templates?.length || !body.variables) {
      return NextResponse.json({ error: 'templates and variables required' }, { status: 400 });
    }

    const domain = body.variables.PUBLIC_DOMAIN;
    if (!domain) {
      return NextResponse.json({ error: 'PUBLIC_DOMAIN variable required' }, { status: 400 });
    }

    // Extract OIDC client definitions from template variables.json files
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clients: any[] = [];
    for (const tmpl of body.templates) {
      const meta = await getTemplateVariables(tmpl.name, tmpl.source);
      if (!meta) continue;

      for (const [varName, varMeta] of Object.entries(meta)) {
        const oidc = varMeta.oidcClient;
        if (!oidc || varMeta.type !== 'subdomain') continue;

        const subdomain = body.variables[varName];
        if (!subdomain) continue;

        const fqdn = `${subdomain}.${domain}`;
        const redirectUris = oidc.redirect_uris.map(uri =>
          uri.startsWith('http') || uri.includes(':/') ? uri : `https://${fqdn}${uri}`
        );

        clients.push({
          client_id: oidc.client_id,
          client_name: oidc.client_name,
          authorization_policy: oidc.authorization_policy,
          redirect_uris: redirectUris,
          scopes: oidc.scopes,
          client_secret: generateSecret(),
        });
      }
    }

    if (clients.length === 0) {
      return NextResponse.json({ added: [], skipped: [], message: 'No OIDC clients found in templates' });
    }

    // Find which node has Authelia deployed
    const twin = DigitalTwinStore.getInstance();
    const nodes = Object.keys(twin.nodes);
    let autheliaNode: string | null = null;
    let autheliaYaml = '';
    for (const nodeName of nodes) {
      try {
        const files = await ServiceManager.getServiceFiles(nodeName, 'authelia');
        if (files.yamlContent) {
          autheliaNode = nodeName;
          autheliaYaml = files.yamlContent;
          break;
        }
      } catch {
        // Not on this node
      }
    }

    if (!autheliaNode || !autheliaYaml) {
      return NextResponse.json({ error: 'Authelia is not deployed' }, { status: 404 });
    }

    // Find the config volume path from Authelia's pod YAML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs = yaml.loadAll(autheliaYaml) as any[];
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

    // Read the current Authelia configuration
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(autheliaNode);
    const readRes = await agent.sendCommand('read_file', { path: configFilePath });
    const currentConfig = readRes.content || readRes.stdout || '';

    if (!currentConfig) {
      return NextResponse.json({ error: 'Could not read Authelia configuration' }, { status: 500 });
    }

    // Parse the config to check for existing clients
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const autheliaConfig = yaml.load(currentConfig) as any;
    const existingClients = autheliaConfig?.identity_providers?.oidc?.clients || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingIds = new Set(existingClients.map((c: any) => c.client_id));

    const added: string[] = [];
    const skipped: string[] = [];

    for (const client of clients) {
      if (existingIds.has(client.client_id)) {
        skipped.push(client.client_id);
        continue;
      }

      existingClients.push({
        client_id: client.client_id,
        client_name: client.client_name,
        client_secret: `$plaintext$${client.client_secret}`,
        public: false,
        authorization_policy: client.authorization_policy || 'one_factor',
        redirect_uris: client.redirect_uris,
        scopes: client.scopes || ['openid', 'profile', 'email', 'groups'],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_post',
      });
      added.push(client.client_id);
    }

    if (added.length === 0) {
      return NextResponse.json({ added, skipped, message: 'All clients already registered' });
    }

    // Update the config and write it back
    if (!autheliaConfig.identity_providers) autheliaConfig.identity_providers = {};
    if (!autheliaConfig.identity_providers.oidc) autheliaConfig.identity_providers.oidc = {};
    autheliaConfig.identity_providers.oidc.clients = existingClients;

    const newConfig = yaml.dump(autheliaConfig, { lineWidth: -1, quotingType: "'", forceQuotes: false });
    await agent.sendCommand('write_file', { path: configFilePath, content: newConfig });

    // Restart Authelia to pick up changes
    try {
      await ServiceManager.restartService(autheliaNode, 'authelia');
    } catch {
      // Non-fatal: config is written, restart can be done manually
    }

    return NextResponse.json({ added, skipped });
  } catch (error) {
    console.error('Failed to register OIDC clients:', error);
    const message = error instanceof Error ? error.message : 'Failed to register OIDC clients';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
