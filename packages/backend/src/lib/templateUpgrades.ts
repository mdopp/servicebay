/**
 * Pending template-upgrade aggregation (#2252, extracted from the
 * `GET /api/system/templates/upgrades-pending` route).
 *
 * "Which deployed services have a pending template (schema-version) upgrade?" —
 * the same comparison the per-template `upgrade-preview` endpoint does, fanned
 * out across every entry in `config.installedTemplates`. Lifted out of the
 * route so both `/api/system/templates/upgrades-pending` and the companion
 * app's `/napi/upgrades` read from ONE implementation instead of copying the
 * fan-out.
 */
import { getConfig } from './config';
import { getTemplateYaml, getTemplateChangelog } from './registry';
import { parseTemplateSchemaVersion } from './templateSchemaVersion';
import { parseChangelog, filterUpgradeSections, hasBreakingChanges } from './templateChangelog';

export interface UpgradeSummary {
  name: string;
  installedVersion: number;
  currentVersion: number;
  hasBreakingChange: boolean;
  /** Section headers between the installed and current version, ascending.
   *  Used for the badge tooltip. */
  sectionHeaders: string[];
}

/**
 * Fan out over `config.installedTemplates` and return one entry per service
 * whose registry template schema-version is ahead of what's installed. A single
 * template failing to read never takes the whole aggregate down.
 */
export async function getPendingTemplateUpgrades(): Promise<UpgradeSummary[]> {
  const config = await getConfig();
  const installed = config.installedTemplates ?? {};

  const summaries: UpgradeSummary[] = [];
  for (const [name, record] of Object.entries(installed)) {
    // Skip names that wouldn't pass the per-template route's validation —
    // they can't have a CHANGELOG anyway.
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) continue;
    try {
      const yaml = await getTemplateYaml(name);
      if (yaml === null) continue;
      const currentVersion = parseTemplateSchemaVersion(yaml);
      if (currentVersion <= record.schemaVersion) continue;
      const changelog = await getTemplateChangelog(name);
      const allSections = parseChangelog(changelog ?? '');
      const sections = filterUpgradeSections(allSections, record.schemaVersion, currentVersion);
      if (sections.length === 0) {
        // Version moved forward but the template has no CHANGELOG to explain
        // why — still flag it, with an empty header list.
        summaries.push({
          name,
          installedVersion: record.schemaVersion,
          currentVersion,
          hasBreakingChange: false,
          sectionHeaders: [],
        });
        continue;
      }
      summaries.push({
        name,
        installedVersion: record.schemaVersion,
        currentVersion,
        hasBreakingChange: hasBreakingChanges(sections),
        sectionHeaders: sections.map(s => `v${s.version}${s.breaking ? ' (breaking)' : ''}`),
      });
    } catch {
      // A single template failing yaml-read shouldn't take the whole aggregate
      // down — the wizard's modal surfaces the real error on Re-deploy.
    }
  }

  return summaries;
}
