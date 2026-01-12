import { NextResponse } from 'next/server';
import { getConfig, saveConfig, AppConfig } from '@/lib/config';
import { getTemplateSettingsSchema } from '@/lib/registry';

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
  try {
    const body = await request.json();
    const currentConfig = await getConfig();
    
    // Deep merge or just replace sections? 
    // For now, let's assume the UI sends the full config or we merge carefully.
    // Here we'll merge the notifications section specifically if present.
    
    const newConfig: AppConfig = {
      ...currentConfig,
      ...body,
      templateSettings: body.templateSettings ?? currentConfig.templateSettings,
      notifications: body.notifications ? {
        ...currentConfig.notifications,
        ...body.notifications
      } : currentConfig.notifications
    };

    await saveConfig(newConfig);
    return NextResponse.json(newConfig);
  } catch (error) {
    console.error('Failed to save config:', error);
    return NextResponse.json({ error: 'Failed to save config' }, { status: 500 });
  }
}
