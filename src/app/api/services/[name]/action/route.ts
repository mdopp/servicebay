import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';
import { apiError } from '@/lib/api/errors';

const VALID_ACTIONS = ['start', 'stop', 'restart', 'update'];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const parsed = await parseRouteParam(params, 'name', ServiceName);
  if (!parsed.ok) return parsed.response;
  const name = parsed.value;
  const { action } = await request.json();
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node') || 'Local';

  if (!VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  try {
    let result;
    switch (action) {
      case 'start':
        await ServiceManager.startService(nodeName, name);
        result = await ServiceManager.getServiceStatus(nodeName, name);
        break;
      case 'stop':
        await ServiceManager.stopService(nodeName, name);
        result = await ServiceManager.getServiceStatus(nodeName, name);
        break;
      case 'restart':
        await ServiceManager.restartService(nodeName, name);
        result = await ServiceManager.getServiceStatus(nodeName, name);
        break;
      case 'update':
        result = await ServiceManager.updateAndRestartService(nodeName, name);
        break;
    }
    return NextResponse.json(result);
  } catch (e) {
    return apiError(e, { tag: 'api:services:action', status: 500 });
  }
}
