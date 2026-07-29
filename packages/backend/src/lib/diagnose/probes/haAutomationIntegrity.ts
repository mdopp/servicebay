/**
 * `ha_automation_integrity` probe (#1864) — guards against the Home Assistant
 * automations/scripts/scenes data-loss incident.
 *
 * Three distinct hazards, surfaced as one row:
 *
 *  1. **Registry/config mismatch.** HA's entity registry
 *     (`<config>/.storage/core.entity_registry`) lists N>0 entities of a
 *     platform (`automation` / `script` / `scene`) but the corresponding
 *     include target file (`automations.yaml` / `scripts.yaml` /
 *     `scenes.yaml`) parses to 0 entries. That is the fingerprint of the
 *     incident: the registry still references the automations but their YAML
 *     is empty, so HA is one start away from overwriting the only copy. The
 *     pre-start hook (`runHomeAssistantHook`) now refuses to start HA in this
 *     state; this probe surfaces the same condition in diagnose so it's
 *     visible without a deploy.
 *
 *  2. **A post-deploy-detected reset (#2444).** `templates/home-assistant/
 *     post-deploy.py` records the emptiness of the three include targets on
 *     every deploy and stamps `lastRegression` into
 *     `<config>/.sb_include_snapshot.json` when a file that held content at the
 *     last deploy comes back empty. That covers the variant hazard 1 is blind
 *     to: HA resetting the entity registry along with the YAML, leaving no
 *     registry entries to mismatch against. Surfaced only while the flagged
 *     file is still empty, so restoring it clears the row.
 *
 *  3. **No effective backup target.** HA owns automations/scripts/scenes but
 *     no external backup destination resolves — so a future emptying would be
 *     unrecoverable. Crucially this checks the EFFECTIVE target via
 *     `resolveBackupTarget()`, which defaults to `config.gateway` (the
 *     FritzBox) when `config.externalBackup` is unset. A bare null-check on
 *     `externalBackup` would false-warn on every box that backs up to the
 *     gateway by default.
 *
 * Read-only: the probe never writes, repairs, or deletes anything on the host.
 */
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { resolveBackupTarget } from '@/lib/externalBackup/nasClient';
import { logger } from '@/lib/logger';
import yaml from 'js-yaml';

export interface HaAutomationIntegrityResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

const DEFAULT_STACKS_DIR = '/mnt/data/stacks';

/** The three UI-editable include targets and the registry platform each maps to. */
const INCLUDES: { file: string; platform: string }[] = [
  { file: 'automations.yaml', platform: 'automation' },
  { file: 'scripts.yaml', platform: 'script' },
  { file: 'scenes.yaml', platform: 'scene' },
];

/** Count entity-registry entries for a `platform`. The registry is JSON of the
 *  shape `{ data: { entities: [{ platform }, ...] } }`. Unparseable → 0. */
export function countRegistryPlatformEntries(registryJson: string, platform: string): number {
  try {
    const parsed = JSON.parse(registryJson) as { data?: { entities?: Array<{ platform?: string }> } };
    const entities = parsed?.data?.entities;
    if (!Array.isArray(entities)) return 0;
    return entities.filter((e) => e?.platform === platform).length;
  } catch {
    return 0;
  }
}

/** Parse a HA include target file and return its entry count. Automations and
 *  scenes are YAML lists (`[]` → 0); scripts are a mapping (`{}` → 0). Blank →
 *  0. Unparseable → null (don't raise a false mismatch on a file we can't read). */
export function parseHaEntryCount(content: string): number | null {
  const trimmed = content.trim();
  if (trimmed === '') return 0;
  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch {
    return null;
  }
  if (doc === null || doc === undefined) return 0;
  if (Array.isArray(doc)) return doc.length;
  if (typeof doc === 'object') return Object.keys(doc as object).length;
  return null;
}

/** Minimal slice of the agent we use here — keeps this file decoupled from
 *  the full handler type while staying exec-shaped. */
type ExecAgent = { sendCommand(action: string, params?: { command?: string }): Promise<{ stdout?: string }> };

/** Read `<dir>/<file>` from the host, returning '' for a missing file. */
async function readFileOrEmpty(agent: ExecAgent, dir: string, file: string): Promise<string> {
  const res = await agent.sendCommand('exec', { command: `cat ${dir}/${file} 2>/dev/null || echo MISSING` });
  const raw = res.stdout ?? '';
  return raw.trim() === 'MISSING' ? '' : raw;
}

/** Hazard-1 scan: for each include whose registry count is N>0 but whose
 *  config file parses to 0 entries, return a human-readable mismatch line.
 *  Also returns the total registered count (used for the backup check). */
async function scanIncludeMismatches(
  agent: ExecAgent,
  haConfigDir: string,
  registryJson: string,
): Promise<{ mismatches: string[]; totalRegistered: number }> {
  const mismatches: string[] = [];
  let totalRegistered = 0;
  for (const inc of INCLUDES) {
    const registered = countRegistryPlatformEntries(registryJson, inc.platform);
    totalRegistered += registered;
    if (registered === 0) continue;

    const parsed = parseHaEntryCount(await readFileOrEmpty(agent, haConfigDir, inc.file));
    if (parsed === null) continue; // unparseable — HA's own error, not ours
    if (parsed === 0) {
      mismatches.push(
        `${inc.file} (registry lists ${registered} ${inc.platform} entit${registered === 1 ? 'y' : 'ies'}, file has 0)`,
      );
    }
  }
  return { mismatches, totalRegistered };
}

/** The sidecar `post-deploy.py` writes next to the include targets (#2444). */
const GUARD_SNAPSHOT_FILE = '.sb_include_snapshot.json';

/** Pull the `lastRegression` stamp out of the post-deploy guard's sidecar.
 *  Returns null when absent/unparseable, or when it names no known include
 *  file — the filenames are used to build a `cat` command, so anything outside
 *  the three we ship is dropped rather than trusted. */
export function parseGuardRegression(
  snapshotJson: string,
): { files: string[]; detectedAt: string | null } | null {
  let parsed: { lastRegression?: { files?: unknown; detectedAt?: unknown } };
  try {
    parsed = JSON.parse(snapshotJson) as typeof parsed;
  } catch {
    return null;
  }
  const reg = parsed?.lastRegression;
  if (!reg || typeof reg !== 'object') return null;
  const known = new Set(INCLUDES.map((i) => i.file));
  const files = Array.isArray(reg.files)
    ? reg.files.filter((f): f is string => typeof f === 'string' && known.has(f))
    : [];
  if (files.length === 0) return null;
  return { files, detectedAt: typeof reg.detectedAt === 'string' ? reg.detectedAt : null };
}

/** Hazard-2 scan: the files the post-deploy guard flagged as reset AND which
 *  are still empty right now (a restored file clears itself). */
async function scanGuardRegression(
  agent: ExecAgent,
  haConfigDir: string,
): Promise<{ files: string[]; detectedAt: string | null }> {
  const stamp = parseGuardRegression(await readFileOrEmpty(agent, haConfigDir, GUARD_SNAPSHOT_FILE));
  if (!stamp) return { files: [], detectedAt: null };
  const stillEmpty: string[] = [];
  for (const file of stamp.files) {
    const parsed = parseHaEntryCount(await readFileOrEmpty(agent, haConfigDir, file));
    if (parsed === 0) stillEmpty.push(file);
  }
  return { files: stillEmpty, detectedAt: stamp.detectedAt };
}

export async function checkHaAutomationIntegrity(
  nodeName: string = 'Local',
): Promise<HaAutomationIntegrityResult> {
  const config = await getConfig();
  const stacksDir = config.templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
  const haConfigDir = `${stacksDir}/home-assistant/homeassistant`;

  const agent = await agentManager.ensureAgent(nodeName);

  // Skip cleanly when HA isn't installed on this node.
  const dirExists = await agent.sendCommand('exec', {
    command: `test -d ${haConfigDir} && echo yes || echo no`,
  });
  if (dirExists.stdout?.trim() !== 'yes') {
    return { status: 'info', detail: 'Home Assistant is not installed on this node.' };
  }

  const registryJson = await readFileOrEmpty(agent, haConfigDir, '.storage/core.entity_registry');

  // ── Hazard 1: registry lists entities but the config file is empty. ──
  let totalRegistered = 0;
  if (registryJson.trim() !== '') {
    const scan = await scanIncludeMismatches(agent, haConfigDir, registryJson);
    if (scan.mismatches.length > 0) return mismatchWarning(scan.mismatches, haConfigDir);
    totalRegistered = scan.totalRegistered;
  }

  // ── Hazard 2: the post-deploy guard recorded a reset and the file is still
  // empty. Checked even without a registry — the variant this catches is HA
  // resetting the registry too, which would make hazard 1 silent. ──
  const guarded = await scanGuardRegression(agent, haConfigDir);
  if (guarded.files.length > 0) return guardRegressionWarning(guarded.files, guarded.detectedAt, haConfigDir);

  if (registryJson.trim() === '') {
    return {
      status: 'info',
      detail: 'Home Assistant has no entity registry yet (fresh install) — nothing to check.',
    };
  }

  // ── Hazard 3: HA owns entities but no effective backup target resolves. ──
  if (totalRegistered > 0 && !(await resolveBackupTarget())) return noBackupWarning(totalRegistered);

  return {
    status: 'ok',
    detail:
      totalRegistered > 0
        ? `Home Assistant's ${totalRegistered} registered automation/script/scene entit${totalRegistered === 1 ? 'y' : 'ies'} match their config files and an external backup target is configured.`
        : 'Home Assistant has no automations/scripts/scenes registered — nothing at risk.',
  };
}

/** Hazard-1 warn result: registry references entities the config files lack. */
function mismatchWarning(mismatches: string[], haConfigDir: string): HaAutomationIntegrityResult {
  logger.warn('diagnose:ha_automation_integrity', `registry/config mismatch: ${mismatches.join('; ')}`);
  return {
    status: 'warn',
    detail:
      `Home Assistant's entity registry references automations/scripts/scenes that are MISSING from their config files: ${mismatches.join('; ')}. ` +
      `This is the data-loss fingerprint — the registry remembers them but the YAML is empty.`,
    hint:
      'Do NOT restart Home Assistant before recovering this data — a start would overwrite the only remaining copy. ' +
      `Restore ${haConfigDir} from a backup (or confirm the data really was removed) first.`,
  };
}

/** Hazard-2 warn result: the deploy-time guard saw a non-empty include target
 *  come back empty, and it still is. */
function guardRegressionWarning(
  files: string[],
  detectedAt: string | null,
  haConfigDir: string,
): HaAutomationIntegrityResult {
  logger.warn('diagnose:ha_automation_integrity', `post-deploy reset guard: ${files.join(', ')} came back empty`);
  return {
    status: 'warn',
    detail:
      `Home Assistant emptied ${files.join(', ')} during a redeploy${detectedAt ? ` on ${detectedAt}` : ''} — ` +
      `${files.length === 1 ? 'the file' : 'the files'} held content at the previous deploy and ${files.length === 1 ? 'is' : 'are'} still empty. ` +
      `ServiceBay did not write ${files.length === 1 ? 'it' : 'them'}; this is the config-reset fingerprint from #2444.`,
    hint:
      `Recover from Home Assistant's own automatic backup (Settings → System → Backups) or a ServiceBay backup of ${haConfigDir}, ` +
      'then reload the affected integration. If you deleted this config yourself, the row clears at the next home-assistant deploy.',
  };
}

/** Hazard-3 warn result: HA owns entities but no effective backup destination. */
function noBackupWarning(totalRegistered: number): HaAutomationIntegrityResult {
  return {
    status: 'warn',
    detail:
      `Home Assistant has ${totalRegistered} automation/script/scene entit${totalRegistered === 1 ? 'y' : 'ies'} but no external backup is configured — ` +
      `there is nowhere to recover this config from if it's emptied or a reinstall wipes the box.`,
    hint:
      'Add a backup destination: configure the FritzBox gateway (host + login) in Settings → Integrations, ' +
      'or set an explicit external-backup target. Without one, the automations have no off-box copy.',
  };
}
