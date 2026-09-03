/**
 * Schema migrations for one upgraded item (#2742 — split out of `runner.ts`).
 *
 * Discovers whether the box is behind the template's declared schema version
 * and, if so, selects the chain of `migrations/v{N}-to-v{N+1}.py` steps that
 * closes the gap. The steps ship **by reference** (filename + hop metadata) —
 * the deploy route resolves each body from the same registry (#2503) — and
 * their bodies are never Mustache-rendered (#2435).
 */
import {
  getTemplateMigrationScripts,
  type TemplateMigrationScript,
} from '@/lib/registry';
import {
  selectMigrationChain,
  checkMinUpgradableSchemaVersion,
  MIGRATION_REFUSAL_PREFIX,
} from '@/lib/stackInstall/migrations';
import { parseTemplateSchemaVersion, parseTemplateMinUpgradableSchemaVersion } from '@/lib/templateSchemaVersion';
import type { JobInput } from '../jobStore';
import { apiFetch, log } from './context';

/** One resolved hop, as it travels to the deploy route. */
export interface MigrationStep {
  filename: string;
  fromVersion: number;
  toVersion: number;
  content: string;
}

/**
 * Shape a selected migration chain into the deploy payload, bodies
 * **verbatim** — never Mustache-rendered (#2435).
 *
 * Same contract as `loadPostDeployScript` in `./assetTransport`, for the same
 * reasons: Mustache deletes every `{{…}}` it doesn't recognise, and splicing
 * raw values into Python source is a syntax hazard. Migrations are the
 * *worst* place for either failure mode — they are fail-fast, they run
 * before the new manifest lands, and they touch operator data.
 *
 * The env channel is identical plus the hop metadata: the deploy sends
 * `postDeployEnv` (every wizard variable, HOST, LAN_IP, OPERATOR_EMAIL)
 * whenever a chain is present, and
 * `ServiceManager.buildMigrationEnvLines` adds `SB_NODE`, `SB_API_URL`,
 * `SB_API_TOKEN`, `OLD_DATA_DIR`/`NEW_DATA_DIR` and
 * `OLD_SCHEMA_VERSION`/`NEW_SCHEMA_VERSION`.
 *
 * Keep this a pass-through. If a migration needs a value, read it from
 * `os.environ` — do not reintroduce rendering.
 */
export function buildMigrationSteps(
  chain: TemplateMigrationScript[],
): MigrationStep[] {
  return chain.map(s => ({
    filename: s.filename,
    fromVersion: s.fromVersion,
    toVersion: s.toVersion,
    content: s.content,
  }));
}

/**
 * The operator-facing refusal for a chain that cannot be walked. Both shapes
 * carry the same prefix (`MIGRATION_REFUSAL_PREFIX`) so the best-effort catch
 * below re-throws them instead of swallowing them as "continuing without
 * migrations".
 */
function describeChainRefusal(
  itemName: string,
  result: Extract<ReturnType<typeof selectMigrationChain>, { ok: false }>,
): string {
  return result.reason === 'missing-step'
    ? `Migration chain for ${itemName} is incomplete: no script for v${result.from}→v${result.expectedNext} (have ${result.available.length === 0 ? 'none' : result.available.map(v => `v${v}`).join(', ')}). Aborting deploy.`
    : `Migration chain for ${itemName} has overlapping/invalid steps (${result.conflicts.map(c => `v${c.fromVersion}→v${c.toVersion}`).join(', ')}). Aborting deploy.`;
}

/**
 * Resolve the migration chain for one item, if it needs one.
 *
 * Best-effort by design: a fetch failure here shouldn't block the deploy —
 * if migrations are actually needed and we skipped them, the new container
 * will fail to start and diagnose will surface it. The ONE thing that is not
 * best-effort is a refusal (`MIGRATION_REFUSAL_PREFIX`, or the declared
 * upgrade floor): those re-throw so the deploy stops with the box untouched.
 */
export async function runMigrationsPhase(
  jobId: string,
  input: JobInput,
  item: { name: string; yaml: string },
): Promise<MigrationStep[] | undefined> {
  let migrations: MigrationStep[] | undefined;
  try {
    const targetVersion = parseTemplateSchemaVersion(item.yaml);
    const previewUrl = `/api/system/templates/${encodeURIComponent(item.name)}/upgrade-preview`
      + (input.templateSource && input.templateSource !== 'Built-in' ? `?source=${encodeURIComponent(input.templateSource)}` : '');
    const previewRes = await apiFetch(previewUrl);
    if (previewRes.ok) {
      const preview = await previewRes.json();
      const installedVersion = typeof preview.installedVersion === 'number' ? preview.installedVersion : null;
      if (installedVersion !== null && installedVersion < targetVersion) {
        // #2727 — the declared upgrade floor is checked BEFORE the chain is
        // selected, so a box below it is told what is actually wrong (its
        // recorded version is older than this template supports) instead of
        // getting a `missing-step` message about a script filename it has no
        // way to act on. Same message reaches the MCP `install_template`
        // caller: the throw lands in `job.error` + the install log, which is
        // what `get_install_progress` returns.
        const floorRefusal = checkMinUpgradableSchemaVersion(
          item.name,
          installedVersion,
          parseTemplateMinUpgradableSchemaVersion(item.yaml),
          targetVersion,
        );
        if (floorRefusal) {
          await log(jobId, `❌ ${floorRefusal}`);
          throw new Error(floorRefusal);
        }
        const scripts = await getTemplateMigrationScripts(item.name, input.templateSource);
        const result = selectMigrationChain(installedVersion, targetVersion, scripts);
        if (!result.ok) {
          const msg = describeChainRefusal(item.name, result);
          await log(jobId, `❌ ${msg}`);
          throw new Error(msg);
        }
        if (result.chain.length > 0) {
          migrations = buildMigrationSteps(result.chain);
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(MIGRATION_REFUSAL_PREFIX)) throw e;
    await log(jobId, `⚠️ ${item.name}: could not check migration chain (${e instanceof Error ? e.message : String(e)}). Continuing without migrations.`);
  }
  return migrations;
}
