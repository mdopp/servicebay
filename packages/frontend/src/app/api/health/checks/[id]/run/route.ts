import { NextResponse } from 'next/server';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import { CheckIdString } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';
import { withApiHandlerParams } from '@/lib/api/handler';

type Params = { id: string };

export const POST = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const check = CheckIdString.safeParse(params.id);
    if (!check.success) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    const id = check.data;
    const checks = HealthStore.getChecks();
    const target = checks.find(c => c.id === id);

    if (!target) {
      return NextResponse.json({ error: 'Check not found' }, { status: 404 });
    }

    try {
      const result = await CheckRunner.run(target);
      return NextResponse.json(result);
    } catch (e: unknown) {
      return apiError(e, { tag: 'api:health:run', status: 500 });
    }
  },
);
