import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import { getCurrentJob } from '@/lib/install/jobStore';
import { startTemplateInstall } from '@/lib/install/startTemplateInstall';

export const dynamic = 'force-dynamic';

const Body = z.object({
  template: z.string().min(1),
  variables: z.record(z.string(), z.string()).optional(),
  templateSource: z.string().optional(),
  node: z.string().optional(),
});

/**
 * POST /api/install/template (#2990) — install a template, the full wizard way.
 *
 * The REST twin of the MCP tool `install_template`, and the route the agent
 * CLI's `install` verb speaks. It carries `tokenScope: 'mutate'`, the same tier
 * that tool has held since #2141 — deliberately NOT the `lifecycle` that
 * `/api/install/start` carries, because that route finishes a wizard flow an
 * operator is already driving, while this one starts an install from nothing
 * on a caller's say-so.
 *
 * This is the direct sibling of `/api/install/requests`, and the pair is the
 * whole of ADR 0017: a token holding `propose` may only ASK (that route files
 * an approval and installs nothing); a token holding `mutate` may install. The
 * CLI does not decide which — the token does, and each route says what it is.
 *
 * `wipeMode` is not a parameter: an install started this way is additive,
 * always (ADR 0004). Wiping data is an operator decision and stays in the
 * wizard.
 */
export const POST = withApiHandler<z.infer<typeof Body>>({ body: Body, tokenScope: 'mutate' }, async ({ body }) => {
  const active = await getCurrentJob();
  if (active) {
    return NextResponse.json(
      {
        error: `An install job is already in progress (jobId=${active.id}, phase=${active.phase}). `
          + 'Wait for it to finish or abort it before starting another.',
      },
      { status: 409 },
    );
  }
  try {
    const started = await startTemplateInstall({
      names: [body.template],
      ...(body.templateSource ? { templateSource: body.templateSource } : {}),
      variables: body.variables ?? {},
      ...(body.node ? { node: body.node } : {}),
    });
    return NextResponse.json(started);
  } catch (error) {
    logger.error('api:install:template', `starting an install of ${body.template} failed`, error);
    return NextResponse.json(
      { error: `starting the install failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
});
