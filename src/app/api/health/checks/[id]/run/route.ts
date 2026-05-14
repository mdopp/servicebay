import { NextResponse } from 'next/server';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import { CheckIdString } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';
import { apiError } from '@/lib/api/errors';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = await parseRouteParam(params, 'id', CheckIdString);
  if (!parsed.ok) return parsed.response;
  const id = parsed.value;
  const checks = HealthStore.getChecks();
  const check = checks.find(c => c.id === id);

  if (!check) {
    return NextResponse.json({ error: 'Check not found' }, { status: 404 });
  }

  try {
    const result = await CheckRunner.run(check);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return apiError(e, { tag: 'api:health:run', status: 500 });
  }
}
