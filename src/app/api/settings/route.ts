import { NextResponse } from 'next/server';
import { getConfig, saveConfig, AppConfig } from '@/lib/config';
import { getTemplateSettingsSchema } from '@/lib/registry';
import { DigitalTwinStore } from '@/lib/store/twin';
import { logger } from '@/lib/logger';
import { AppConfigPartialSchema, formatConfigErrors } from '@/lib/config/schema';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async () => {
  const [config, templateSettingsSchema] = await Promise.all([
    getConfig(),
    getTemplateSettingsSchema(),
  ]);
  return NextResponse.json({ ...config, templateSettingsSchema });
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
 */
export const POST = withApiHandler({}, async ({ request }) => {
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
  };

  await saveConfig(newConfig);

  if ('serverName' in validated) {
    DigitalTwinStore.getInstance().setServerName(newConfig.serverName ?? null);
  }

  return NextResponse.json(newConfig);
});
