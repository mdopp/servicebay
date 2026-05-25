import { NextResponse } from 'next/server';
import { HealthStore } from '@/lib/health/store';
import { CheckIdString } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';

type Params = { id: string };

export const GET = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const check = CheckIdString.safeParse(params.id);
    if (!check.success) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    const results = HealthStore.getResults(check.data);
    return NextResponse.json(results);
  },
);
