import { NextResponse } from 'next/server';
import { MonitoringStore } from '@/lib/monitoring/store';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const results = MonitoringStore.getResults(id);
  return NextResponse.json(results);
}
