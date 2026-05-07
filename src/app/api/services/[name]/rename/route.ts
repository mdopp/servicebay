import { NextRequest, NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';
import { apiError } from '@/lib/api/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const parsed = await parseRouteParam(params, 'name', ServiceName);
  if (!parsed.ok) return parsed.response;
  const name = parsed.value;
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node') || 'Local';

  try {
    const body = await request.json();
    const { newName } = body;

    if (!newName) {
      return NextResponse.json({ error: 'New name is required' }, { status: 400 });
    }

    const newCheck = ServiceName.safeParse(newName);
    if (!newCheck.success) {
      return NextResponse.json({ error: 'invalid newName' }, { status: 400 });
    }

    await ServiceManager.renameService(nodeName, name, newCheck.data);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiError(error, { tag: 'api:services:rename', status: 500 });
  }
}
