import { NextResponse } from 'next/server';
import { MonitoringStore } from '@/lib/monitoring/store';
import { CheckRunner } from '@/lib/monitoring/runner';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const checks = MonitoringStore.getChecks();
  const check = checks.find(c => c.id === id);

  if (!check) {
    return NextResponse.json({ error: 'Check not found' }, { status: 404 });
  }

  try {
    const result = await CheckRunner.run(check);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
