import { NextResponse } from 'next/server';
import { getConfig, saveConfig, AppConfig } from '@/lib/config';
import { getTemplateSettingsSchema } from '@/lib/registry';
import { DigitalTwinStore } from '@/lib/store/twin';
import { logger } from '@/lib/logger';
import { AppConfigPartialSchema, formatConfigErrors } from '@/lib/config/schema';

export async function GET() {
  const [config, templateSettingsSchema] = await Promise.all([
    getConfig(),
    getTemplateSettingsSchema()
  ]);

  return NextResponse.json({
    ...config,
    templateSettingsSchema
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate the body shape against AppConfigSchema BEFORE merging (#595).
  // `.partial().strict()` rejects unknown top-level keys (catches typos
  // like `servername` vs `serverName` before they corrupt config.json)
  // and wrong-typed primitives, while still allowing PATCH-style writes
  // that only touch a subset of fields. Complex nested objects pass
  // through for now — tightening them is purely additive.
  const parsed = AppConfigPartialSchema.safeParse(body);
  if (!parsed.success) {
    const errors = formatConfigErrors(parsed.error);
    logger.warn('api:settings:post', `Rejected config write — ${errors.length} validation error(s):`, errors);
    return NextResponse.json({ error: 'Invalid settings payload', details: errors }, { status: 400 });
  }
  const validated = parsed.data as Partial<AppConfig>;

  try {
    const currentConfig = await getConfig();

    // Merge — same shallow shape the old code used. notifications is
    // shallow-merged so the UI can send a partial notifications block.
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
  } catch (error) {
    logger.error('api:settings:post', 'Failed to save config', error);
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
  }
}
