/**
 * App-config MCP tools (#2384 extraction): a redacted read plus an
 * allow-listed write. Auth/OIDC/SMTP credentials are deliberately out of both.
 */
import { z } from 'zod';
import { getConfig, updateConfig, type AppConfig } from '@/lib/config';
import { textResult, errorResult, type ToolRegistration } from './context';

/**
 * Strip secrets and compute-only fields when returning config to the LLM.
 * Anything not listed here is passed through; explicit deletes are below.
 */
const sanitizeConfig = (cfg: AppConfig): Partial<AppConfig> => {
  const out: AppConfig = JSON.parse(JSON.stringify(cfg));
  if (out.auth) delete out.auth.passwordHash;
  if (out.oidc) {
    out.oidc.clientSecret = out.oidc.clientSecret ? '***' : '';
  }
  if (out.notifications?.email) {
    out.notifications.email = { ...out.notifications.email, pass: out.notifications.email.pass ? '***' : '' };
  }
  return out;
};

/**
 * Allowlist: only fields the LLM is allowed to change without explicit user
 * intervention. Auth, OIDC, and notification credentials are deliberately
 * excluded — those need a human in the loop.
 */
const ConfigPatchSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  serverName: z.string().max(64).optional(),
  domain: z.string().max(255).optional(),
  autoUpdate: z.object({
    enabled: z.boolean().optional(),
    schedule: z.string().optional(),
  }).partial().optional(),
  templateSettings: z.record(z.string(), z.string()).optional(),
}).strict();

export function registerConfigTools({ server }: ToolRegistration) {
  server.tool('get_config', 'Read the ServiceBay app config (secrets like password hash and SMTP password redacted)', {}, async () => {
    const config = await getConfig();
    return textResult(sanitizeConfig(config));
  });

  server.tool(
    'update_config',
    'Update select ServiceBay config fields. Allowed: logLevel, serverName, domain, autoUpdate, templateSettings. Auth/OIDC/SMTP are intentionally excluded.',
    { patch: ConfigPatchSchema.describe('Partial config to merge') },
    async ({ patch }) => {
      try {
        const current = await getConfig();
        const merged: Partial<AppConfig> = {};
        if (patch.logLevel !== undefined) merged.logLevel = patch.logLevel;
        if (patch.serverName !== undefined) merged.serverName = patch.serverName;
        if (patch.domain !== undefined) merged.domain = patch.domain;
        if (patch.templateSettings !== undefined) merged.templateSettings = patch.templateSettings;
        if (patch.autoUpdate) {
          merged.autoUpdate = { ...current.autoUpdate, ...patch.autoUpdate };
        }
        const updated = await updateConfig(merged);
        return textResult({ ok: true, config: sanitizeConfig(updated) });
      } catch (err) {
        return errorResult(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
