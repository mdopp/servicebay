import { NextResponse } from 'next/server';
import { renderPodYaml } from '@/lib/template/render';
import { assembleManifest, applyVariableDefaults } from '@/lib/install/manifestAssembler';
import { authDynamicVars, findEmptyYamlVars } from '@/lib/install/runner';
import type { JobInput } from '@/lib/install/jobStore';
import type { VariableMeta } from '@/lib/registry';
import { logger } from '@/lib/logger';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** Variable types whose value is a live credential. An empty one deploys a
 *  service with no password — the #2537 blast radius (a re-render + save on
 *  `auth` takes SSO out for the whole box). */
const SECRET_TYPES = new Set(['secret', 'bcrypt', 'rsa-private']);

/**
 * Re-render a service's kube YAML from the template (#421). Migrated to
 * withApiHandler in #603.
 *
 * Doesn't write or restart — returns the rendered YAML for the editor to drop
 * in; the existing save → restart flow handles the rest.
 *
 * #2537 — this used to build its render view from `templateSettings[name] ??
 * meta.default ?? ''` and nothing else, so every variable that was neither a
 * global Template Setting nor carried a `variables.json` default rendered as an
 * EMPTY STRING. That silently blanked operator-typed values (`installedVariables`,
 * #2531) and, worse, generated secrets (`installedSecrets`, #615) — the operator
 * reviewed a diff whose blanked credentials had scrolled off screen, saved, and
 * redeployed the service with empty passwords.
 *
 * The fix is not a third resolution idiom: the preview now runs the SAME
 * `assembleManifest → applyVariableDefaults` pair that the wizard
 * (`/api/install/assemble` + `/api/install/start`), the `install_template` MCP
 * tool and `POST /napi/services/:name/upgrade` drive for a single service, then
 * renders with the SAME `renderPodYaml` + `authDynamicVars` the install runner's
 * `deployItem` uses. What you see is what a deploy resolves, by construction.
 *
 * The one deliberate difference is `preview: true`: a deploy MINTS a missing
 * secret, a read-only GET must not (it would write `installedSecrets` and hand
 * back YAML that silently rotates a live credential). So a secret the store
 * cannot supply stays empty and is reported instead of substituted — 400 for a
 * normally-generated one (the value is genuinely lost; refuse rather than
 * deploy a blank credential), and listed in `unresolved` for anything else.
 */
/** What a deploy of this one service would render with. `null` when the
 *  template no longer resolves from any registry. */
async function resolveDeployView(serviceName: string): Promise<{
  yamlSource: string;
  view: Record<string, string>;
  metaByName: Map<string, VariableMeta | undefined>;
} | null> {
  const assembled = await assembleManifest({
    items: [{ name: serviceName, checked: true }],
    preview: true,
  });
  const yamlSource = assembled.items[0]?.yaml;
  if (!yamlSource) return null;

  // The same defaults/operator-value backfill `POST /api/install/start` runs
  // over a JobInput before the runner ever sees it (#1297 / #2531).
  const input: JobInput = {
    items: assembled.items,
    variables: assembled.variables,
    templateSource: 'Built-in',
    host: 'localhost',
    wipeMode: 'install',
  };
  // `preview` on BOTH halves of the pair (#2716): the defaults pass mints a
  // ServiceBay API token for a `mintApiToken` slot the manifest can't satisfy,
  // which is the same write-and-rotate side effect `assembleManifest`'s preview
  // flag exists to suppress.
  const withDefaults = await applyVariableDefaults(input, undefined, { preview: true });

  // `deployItem`'s view, verbatim: variables reduced to name → value, plus the
  // dynamic vars the runner injects (LLDAP_FORCE_LDAP_USER_PASS_RESET on `auth`,
  // which `assembleManifest` deliberately drops from the variable set).
  const view: Record<string, string> = {};
  for (const v of withDefaults.variables) view[v.name] = v.value;
  Object.assign(view, authDynamicVars(serviceName));

  const metaByName = new Map(
    withDefaults.variables.map(v => [v.name, v.meta as VariableMeta | undefined]),
  );
  return { yamlSource, view, metaByName };
}

/** Template refs the view cannot satisfy, split by how bad that is. `missing`
 *  is a ref with no variable at all; `lostSecrets` is a normally-generated
 *  credential that resolved EMPTY (refuse — saving it would deploy a service
 *  with no password); `unresolved` is everything else that rendered empty and
 *  is merely reported. */
function findUnsatisfiedRefs(
  yamlSource: string,
  view: Record<string, string>,
  metaByName: Map<string, VariableMeta | undefined>,
): { missing: string[]; lostSecrets: string[]; unresolved: string[] } {
  const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
  const refs = new Set<string>();
  for (const m of yamlSource.matchAll(refRe)) refs.add(m[1]);
  const missing = [...refs].filter(r => !(r in view));

  // Present in the view but EMPTY. This is the hole #2537 was about: the
  // missing-ref check only ever caught ABSENT refs, so a blanked value walked
  // straight through it. Same detector the runner warns with, so preview and
  // deploy agree on what "rendered empty" means (section refs are optional).
  const empty = findEmptyYamlVars(yamlSource, view);
  const lostSecrets = empty.filter(n => {
    const meta = metaByName.get(n);
    return !!meta?.type && SECRET_TYPES.has(meta.type) && !meta.noAutoGenerate;
  });
  return { missing, lostSecrets, unresolved: empty.filter(n => !lostSecrets.includes(n)) };
}

/** The two conditions under which we hand back nothing rather than YAML the
 *  operator would save over a working service. `null` = go ahead and render. */
function refuseIfUnsatisfiable(missing: string[], lostSecrets: string[]): NextResponse | null {
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `The template references variables that aren't in Settings → Template Variables: ${missing.join(', ')}. Set them there first, then try again.`,
        missing,
      },
      { status: 400 },
    );
  }
  if (lostSecrets.length > 0) {
    const one = lostSecrets.length === 1;
    return NextResponse.json(
      {
        error: `Refusing to re-render: the stored value for ${lostSecrets.join(', ')} couldn't be recovered, so ${one ? 'it' : 'they'} would render EMPTY and the re-rendered YAML would deploy this service with no credential. Nothing has been changed. Set ${one ? 'it' : 'them'} in Configure, or reinstall the service, before re-rendering.`,
        unresolvedSecrets: lostSecrets,
      },
      { status: 400 },
    );
  }
  return null;
}

export const GET = withApiHandlerParams<undefined, undefined, { name: string }>(
  {},
  async ({ params }) => {
    const serviceName = decodeURIComponent(params.name);

    let resolved: Awaited<ReturnType<typeof resolveDeployView>>;
    try {
      resolved = await resolveDeployView(serviceName);
    } catch (e) {
      logger.warn('services:reconfigure-preview', `Assemble failed for ${serviceName}: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json(
        { error: `Couldn't resolve "${serviceName}" from its template: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
    if (!resolved) {
      return NextResponse.json(
        { error: `No template named "${serviceName}" found in the registry — can't re-render.` },
        { status: 404 },
      );
    }
    const { yamlSource, view, metaByName } = resolved;

    const { missing, lostSecrets, unresolved } = findUnsatisfiedRefs(yamlSource, view, metaByName);
    const refusal = refuseIfUnsatisfiable(missing, lostSecrets);
    if (refusal) return refusal;

    let rendered: string;
    try {
      rendered = renderPodYaml(yamlSource, view);
    } catch (e) {
      logger.warn('services:reconfigure-preview', `Render failed for ${serviceName}: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json(
        { error: `Template render failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }

    // Anything still empty is NAMED in the response so the operator sees it in
    // the editor instead of discovering the blank after a save.
    return NextResponse.json({ yamlContent: rendered, unresolved });
  },
);
