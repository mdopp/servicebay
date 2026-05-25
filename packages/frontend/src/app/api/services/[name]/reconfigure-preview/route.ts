import { NextResponse } from 'next/server';
import { renderTemplate } from '@/lib/template/render';
import { getConfig } from '@/lib/config';
import { getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { logger } from '@/lib/logger';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Re-render a service's kube YAML from the template using the
 * operator's current `templateSettings` (#421). Migrated to
 * withApiHandler in #603.
 *
 * Doesn't write or restart — returns the rendered YAML for the
 * editor to drop in; the existing save → restart flow handles the
 * rest.
 */
export const GET = withApiHandlerParams<undefined, undefined, { name: string }>(
  {},
  async ({ params }) => {
    const serviceName = decodeURIComponent(params.name);

    const yamlSource = await getTemplateYaml(serviceName);
    if (!yamlSource) {
      return NextResponse.json(
        { error: `No template named "${serviceName}" found in the registry — can't re-render.` },
        { status: 404 },
      );
    }

    const variables = await getTemplateVariables(serviceName);
    const config = await getConfig();
    const templateSettings = config.templateSettings ?? {};

    const view: Record<string, string> = {};
    for (const [name, meta] of Object.entries(variables ?? {})) {
      const value = templateSettings[name] ?? meta.default ?? '';
      view[name] = String(value);
    }

    // Walk the raw yaml for {{VAR}} / {{#VAR}} references and refuse
    // to render when one of them isn't present in the view. Mustache
    // would silently substitute "" — that produces YAML that crashes
    // on deploy. Fail closed with a useful message instead.
    const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
    const refs = new Set<string>();
    for (const m of yamlSource.matchAll(refRe)) refs.add(m[1]);
    const missing = [...refs].filter(r => !(r in view));
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `The template references variables that aren't in Settings → Template Variables: ${missing.join(', ')}. Set them there first, then try again.`,
          missing,
        },
        { status: 400 },
      );
    }

    let rendered: string;
    try {
      rendered = renderTemplate(yamlSource, view);
    } catch (e) {
      logger.warn('services:reconfigure-preview', `Render failed for ${serviceName}: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json(
        { error: `Template render failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ yamlContent: rendered });
  },
);
