import { NextResponse } from 'next/server';
import Mustache from 'mustache';
import { getConfig } from '@/lib/config';
import { getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Re-render a service's kube YAML from the template using the
 * operator's current `templateSettings` (#421, minimal slice).
 *
 * The original install runner renders the YAML once with whatever
 * variables were in scope at install time, then the rendered output
 * lives on disk on the node. If the operator later changes a
 * `templateSettings` value or wants to flip a Mustache conditional
 * (e.g. add a Z-Wave stick to Home Assistant after the fact, #422),
 * there's no built-in way to re-apply the template — you have to
 * hand-edit the YAML.
 *
 * This endpoint takes the service name, looks up the matching
 * template in the registry, and returns the freshly rendered YAML
 * as JSON so the edit form can drop it in. The operator then
 * reviews the diff in the editor and clicks Save — the existing
 * save → restart flow handles the rest.
 *
 * We deliberately don't write to disk or restart here. That keeps
 * the surface small and gives the operator a chance to back out
 * after seeing the rendered output.
 *
 * Caveats / known gaps (follow-up work to fully match the wizard):
 *   - Mustache `view` is built from `templateSettings` only, so
 *     install-time variables that weren't promoted to template
 *     settings (e.g. auto-generated secrets) are missing and the
 *     render fails closed with a 400 listing them. Caller should
 *     update the missing entries in Settings → Template Variables
 *     first.
 *   - Config files (*.mustache) aren't regenerated here; only the
 *     pod yaml. Templates that derive a sidecar config from the
 *     same variables still need a redeploy via the wizard.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name: rawName } = await params;
  const serviceName = decodeURIComponent(rawName);

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
  // to render when one of them isn't present in the view. Mustache's
  // default is to silently substitute "" which produces a YAML that
  // would crash on deploy — fail closed with a useful message instead.
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

  const savedEscape = Mustache.escape;
  Mustache.escape = (text: string) => text;
  let rendered: string;
  try {
    rendered = Mustache.render(yamlSource, view);
  } catch (e) {
    logger.warn('services:reconfigure-preview', `Render failed for ${serviceName}: ${e instanceof Error ? e.message : String(e)}`);
    Mustache.escape = savedEscape;
    return NextResponse.json(
      { error: `Template render failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  } finally {
    Mustache.escape = savedEscape;
  }

  return NextResponse.json({ yamlContent: rendered });
}
