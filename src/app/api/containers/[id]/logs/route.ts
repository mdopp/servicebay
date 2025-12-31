import { NextResponse } from 'next/server';
import { getContainerLogs } from '@/lib/manager';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const logs = await getContainerLogs(id);
  return NextResponse.json({ logs });
}
