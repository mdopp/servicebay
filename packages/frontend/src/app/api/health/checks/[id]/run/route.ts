import { NextResponse } from 'next/server';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import { CheckIdString } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';
import { withApiHandlerParams } from '@/lib/api/handler';
import { isDiagnoseCheckId, runDiagnoseChecks } from '@/lib/diagnose/diagnoseChecks';

type Params = { id: string };

export const POST = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params }) => {
    const check = CheckIdString.safeParse(params.id);
    if (!check.success) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    const id = check.data;

    // #1423: diagnose rows are synthetic (not in checks.json). Running
    // one re-runs the whole suite on-demand and returns this probe's
    // freshly-persisted result.
    //
    // #1709: this is the operator clicking "Run" — a *manual* re-run, so
    // pass manual:true. That makes reader probes over expensive checks
    // (sso_verify) actually re-execute the verification rather than
    // re-displaying a stale stored report. The scheduled tick stays
    // read-only (it calls runDiagnoseChecks without the flag).
    if (isDiagnoseCheckId(id)) {
      try {
        const results = await runDiagnoseChecks('Local', { manual: true });
        const result = results.find(r => r.check_id === id);
        if (!result) {
          return NextResponse.json({ error: 'Diagnose probe not found' }, { status: 404 });
        }
        return NextResponse.json(result);
      } catch (e: unknown) {
        return apiError(e, { tag: 'api:health:run:diagnose', status: 500 });
      }
    }

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
