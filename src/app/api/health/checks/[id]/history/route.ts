import { NextResponse } from 'next/server';
import { HealthStore } from '@/lib/health/store';
import { UuidString } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseRouteParam(params, 'id', UuidString);
  if (!parsed.ok) return parsed.response;
  const results = HealthStore.getResults(parsed.value);
  return NextResponse.json(results);
}
