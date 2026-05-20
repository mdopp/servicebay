import { NextResponse } from 'next/server';
import yaml from 'js-yaml';
import { withApiHandler } from '@/lib/api/handler';
import { humanizeYamlError } from '@/lib/util/humanizeYamlError';
import {
  ValidateYamlRequestSchema,
  type KubeDocSchema,
} from '@servicebay/api-client';
import type { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * Server-side YAML validation for the ServiceForm editor. Phase 2 of
 * the FE/BE separation (#759): the frontend no longer imports `js-yaml`.
 * It POSTs the editor content here and gets back either the parsed
 * manifest or a humanized error.
 *
 * The response mirrors the `KubeDoc` shape the form's `extractInfo`
 * consumes — kept loose (passthrough) because templates routinely
 * carry fields outside the strict K8s schema (servicebay annotations,
 * podman-specific extensions, etc).
 */
export const POST = withApiHandler({ body: ValidateYamlRequestSchema }, async ({ body }) => {
  try {
    const manifest = yaml.load(body.yaml) as z.infer<typeof KubeDocSchema>;
    return NextResponse.json({ ok: true, manifest: manifest ?? {} });
  } catch (e) {
    return NextResponse.json({ ok: false, error: humanizeYamlError(e) });
  }
});
