/**
 * Clear in-memory + on-disk `AppConfig` fields that carry secret state
 * tied to a specific install — used by the Factory Reset endpoint
 * (#623) after the stack wipe so the next wizard run truly starts from
 * zero.
 *
 * Why a dedicated helper: `updateConfig` deep-merges its `Partial<AppConfig>`
 * argument with the current config. Nested objects are merged, not
 * replaced, so passing `lldap: undefined` would not actually remove the
 * `lldap` field. We bypass deepMerge by reading the current config,
 * mutating the fields directly, and writing the whole thing via
 * `saveConfig`. `saveConfig` holds the same write-lock as `updateConfig`
 * so this is safe under concurrent callers.
 *
 * Fields cleared:
 *   - `installedSecrets` — wizard-generated secret material from #615 / #622
 *   - `installManifest` — saved credentials surfaced in Settings → Credentials
 *   - `lldap` / `adguard` — legacy back-compat secret stores
 *   - `reverseProxy.npm` — NPM admin creds (rest of `reverseProxy` kept,
 *     since it also holds operator-set fields like `publicDomain`)
 */
import { getConfig, saveConfig } from '@/lib/config';

export interface ClearSensitiveConfigResult {
  cleared: string[];
}

export async function clearSensitiveConfig(): Promise<ClearSensitiveConfigResult> {
  const config = await getConfig();
  const cleared: string[] = [];

  if (config.installedSecrets && config.installedSecrets.length > 0) {
    delete config.installedSecrets;
    cleared.push('installedSecrets');
  }
  if (config.installManifest) {
    delete config.installManifest;
    cleared.push('installManifest');
  }
  if (config.lldap) {
    delete config.lldap;
    cleared.push('lldap');
  }
  if (config.adguard) {
    delete config.adguard;
    cleared.push('adguard');
  }
  if (config.reverseProxy?.npm) {
    delete config.reverseProxy.npm;
    cleared.push('reverseProxy.npm');
  }

  await saveConfig(config);
  return { cleared };
}
