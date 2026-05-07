import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const resolved = await params;
  const rawName = resolved?.name ?? '';
  let decoded = '';
  try { decoded = decodeURIComponent(rawName); } catch {
    return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
  }
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node') || 'Local';

  if (decoded === 'gateway' || decoded === 'Internet Gateway') {
        const { getConfig } = await import('@/lib/config');
        const { FritzBoxClient } = await import('@/lib/fritzbox/client');
        const config = await getConfig();
        if (config.gateway?.type === 'fritzbox') {
            try {
                const client = new FritzBoxClient(config.gateway);
                const status = await client.getStatus();
                return NextResponse.json({ status: status.connected ? 'active' : 'inactive' });
            } catch {
                return NextResponse.json({ status: 'unknown' });
            }
        }
        return NextResponse.json({ status: 'active' });
  }

  const check = ServiceName.safeParse(decoded);
  if (!check.success) {
    return NextResponse.json({ error: 'invalid name' }, { status: 400 });
  }
  const name = check.data;

  try {
    const status = await ServiceManager.getServiceStatus(nodeName, name);
    return NextResponse.json({ status });
  } catch (e) {
    return apiError(e, { tag: 'api:services:status', status: 500 });
  }
}
