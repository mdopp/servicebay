import { NextResponse } from 'next/server';
import { getConfig, saveConfig, AppConfig, redactSensitiveConfig } from '@/lib/config';
import { getTemplateSettingsSchema } from '@/lib/registry';
import { setServerName } from '@/lib/store/repository';
import { logger } from '@/lib/logger';
import { AppConfigPartialSchema, formatConfigErrors } from '@/lib/config/schema';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({ tokenScope: 'read' }, async ({ auth }) => {
  const [config, templateSettingsSchema] = await Promise.all([
    getConfig(),
    getTemplateSettingsSchema(),
  ]);
  // #1275 — a scoped `sb_` API token (Bearer) gets secrets redacted; cookie
  // (web UI) and internal callers keep plaintext. requireSession tags a token
  // principal as `token:<name>`, so that prefix is the discriminator.
  const isToken = auth?.user.startsWith('token:') ?? false;
  const payload = isToken ? redactSensitiveConfig(config) : config;
  return NextResponse.json({ ...payload, templateSettingsSchema });
});

/**
 * Settings POST — accepts a Partial<AppConfig> via the AppConfigPartialSchema
 * validator (#595), merges with the persisted config, persists, and returns
 * the new full config so the UI doesn't have to re-fetch.
 *
 * Body validation is deliberately done inside the handler rather than via
 * `withApiHandler`'s `body:` slot — `AppConfigPartialSchema` already
 * formats errors with the more detailed `formatConfigErrors` shape the
 * settings UI displays. Re-routing through the handler's Zod path would
 * lose that fidelity.
 *
 * `tokenScope: 'mutate'` (#1275) lets a scoped `sb_` API token (the sb-tui
 * edit-config panel) write config, not just read it via GET. The body is a
 * Partial<AppConfig> that's merged with the persisted config, so a token
 * caller sends only the field(s) it changes — it never round-trips the
 * redacted secrets it received from GET back into the store.
 */
export const POST = withApiHandler({ tokenScope: 'mutate' }, async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = AppConfigPartialSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatConfigErrors(parsed.error);
    logger.warn('api:settings:post', `Rejected config write — ${errors.length} validation error(s):`, errors);
    return NextResponse.json({ error: 'Invalid settings payload', details: errors }, { status: 400 });
  }
  const validated = parsed.data as Partial<AppConfig>;

  const currentConfig = await getConfig();
  const newConfig: AppConfig = {
    ...currentConfig,
    ...validated,
    templateSettings: validated.templateSettings ?? currentConfig.templateSettings,
    notifications: validated.notifications ? {
      ...currentConfig.notifications,
      ...validated.notifications,
    } : currentConfig.notifications,
    // Deep-merge reverseProxy (same one-level merge as notifications) so a
    // caller sending a single nested field — e.g. the sb-tui edit-config
    // panel writing `{ reverseProxy: { publicDomain } }` — doesn't blow
    // away the rest of the block (npm creds, lanDomain, lanIp). The web UI
    // edits the domain via its own server action / /api/system/mode, not
    // here, so this never narrows an existing caller.
    reverseProxy: validated.reverseProxy ? {
      ...currentConfig.reverseProxy,
      ...validated.reverseProxy,
    } : currentConfig.reverseProxy,
  };

  await saveConfig(newConfig);

  if ('serverName' in validated) {
    setServerName(newConfig.serverName ?? null);
  }

  return NextResponse.json(newConfig);
});
