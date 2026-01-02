import { NextResponse } from 'next/server';
import { getContainerInspect } from '@/lib/manager';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const container = await getContainerInspect(id);
  
  if (!container) {
    return NextResponse.json({ error: 'Container not found' }, { status: 404 });
  }

  return NextResponse.json(container);
}
