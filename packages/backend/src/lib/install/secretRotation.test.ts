/**
 * #2574 — an explicitly supplied secret must win over the saved one.
 *
 * The reuse itself (#615) is legitimate: after a reset, a service whose data
 * volume survived must still authenticate, so a secret that nobody supplied
 * comes back from `installedSecrets`. What was wrong is that the reuse also
 * overruled a value the CALLER SUPPLIED — `install_template(mosquitto,
 * {MQTT_PASSWORD: "<new>"})` reported success, logged a cheerful "🔑 Reusing 1
 * saved secret …", and deployed the OLD password. A device that could not
 * handle the generated password (and a leaked password) therefore had no
 * supported rotation path at all.
 *
 * The assertions below deliberately do NOT read the log text — the log is what
 * made this look like it had worked. They assert the PRODUCED ARTEFACT: the
 * rendered pod YAML that the broker's init container reads
 * (`mosquitto_passwd -b -c … "$MQTT_USERNAME" "$MQTT_PASSWORD"`), built from
 * the real `templates/mosquitto` files through the same
 * `assembleManifest → applyVariableDefaults → reuseSavedSecrets → renderPodYaml`
 * chain the install runner drives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VariableMeta } from '@/lib/registry';

const TEMPLATE_DIR = path.resolve(__dirname, '../../../../../templates/mosquitto');
const MOSQUITTO_YAML = fs.readFileSync(path.join(TEMPLATE_DIR, 'template.yml'), 'utf-8');
const MOSQUITTO_VARS = JSON.parse(
  fs.readFileSync(path.join(TEMPLATE_DIR, 'variables.json'), 'utf-8'),
) as Record<string, VariableMeta>;

const getTemplateYaml = vi.fn<(n: string, s?: string) => Promise<string | null>>();
const getTemplateVariables = vi.fn<(n: string, s?: string) => Promise<Record<string, VariableMeta> | null>>();
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: (n: string, s?: string) => getTemplateYaml(n, s),
  getTemplateVariables: (n: string, s?: string) => getTemplateVariables(n, s),
  getTemplateConfigFiles: async () => [],
  getTemplateAssetFiles: async () => [],
  getTemplateSettingsSchema: async () => ({}),
}));

const getConfig = vi.fn<() => Promise<{ templateSettings?: Record<string, string> }>>();
vi.mock('@/lib/config', () => ({ getConfig: () => getConfig() }));

const loadSavedSecrets = vi.fn<() => Record<string, string>>(() => ({}));
const persistSingleSecret = vi.fn<(n: string, v: string) => Promise<boolean>>(async () => true);
vi.mock('./savedSecrets', () => ({
  loadSavedSecrets: () => loadSavedSecrets(),
  persistSingleSecret: (n: string, v: string) => persistSingleSecret(n, v),
}));

vi.mock('./savedVariables', () => ({ loadSavedVariables: () => ({}) }));

import { assembleManifest, applyVariableDefaults } from './manifestAssembler';
import { reuseSavedSecrets, formatSecretRotationLog } from './runner';
import { renderPodYaml } from '@/lib/template/render';
import { REDACTION_SENTINEL } from '@/lib/mcp/redact';
import type { JobInput, JobInputVariable } from './jobStore';

const OLD_PASSWORD = 'Old$Generated~Pw/9f';
const NEW_PASSWORD = 'NukiSafePassword2026';

beforeEach(() => {
  getTemplateYaml.mockReset();
  getTemplateYaml.mockResolvedValue(MOSQUITTO_YAML);
  getTemplateVariables.mockReset();
  getTemplateVariables.mockResolvedValue(MOSQUITTO_VARS);
  getConfig.mockReset();
  getConfig.mockResolvedValue({ templateSettings: {} });
  loadSavedSecrets.mockReset();
  loadSavedSecrets.mockReturnValue({ MQTT_USERNAME: 'mqtt', MQTT_PASSWORD: OLD_PASSWORD });
  persistSingleSecret.mockReset();
  persistSingleSecret.mockResolvedValue(true);
});

/**
 * The install path from an `install_template` call to the YAML the broker is
 * deployed with — the same four steps, in the same order, that
 * `templateTools.install_template` + `runner.runJob`/`deployItem` execute.
 */
async function deployedYaml(supplied: Record<string, string>): Promise<string> {
  const assembled = await assembleManifest({
    items: [{ name: 'mosquitto', checked: true }],
    prefilled: supplied,
  });
  const input: JobInput = {
    items: assembled.items,
    variables: assembled.variables,
    templateSource: 'Built-in',
    host: 'localhost',
    wipeMode: 'install',
  };
  const withDefaults = await applyVariableDefaults(input);
  reuseSavedSecrets(withDefaults.variables, loadSavedSecrets(), new Set<string>(), REDACTION_SENTINEL);
  const view: Record<string, string> = {};
  for (const v of withDefaults.variables) view[v.name] = v.value;
  return renderPodYaml(withDefaults.items[0].yaml ?? '', view);
}

/** The `value: "…"` of a `name: <envName>` pair in the rendered pod. This is
 *  what the container actually receives. */
function envValue(yaml: string, envName: string): string | undefined {
  const m = new RegExp(`name:\\s*${envName}\\n\\s*value:\\s*"([^"]*)"`).exec(yaml);
  return m?.[1];
}

describe('#2574 — a supplied secret reaches the deployed artefact', () => {
  it('deploys the SUPPLIED password, not the saved one', async () => {
    const yaml = await deployedYaml({ MQTT_PASSWORD: NEW_PASSWORD });

    expect(envValue(yaml, 'MQTT_PASSWORD')).toBe(NEW_PASSWORD);
    // The old credential must be gone from the artefact entirely — the broker's
    // init container rebuilds its passwd file from this env on every deploy.
    expect(yaml).not.toContain(OLD_PASSWORD);
  });

  it('still reuses the saved password when nothing was supplied (#615 unchanged)', async () => {
    const yaml = await deployedYaml({});

    expect(envValue(yaml, 'MQTT_PASSWORD')).toBe(OLD_PASSWORD);
  });

  it('leaves the OTHER secrets on their saved values when one is rotated', async () => {
    const yaml = await deployedYaml({ MQTT_PASSWORD: NEW_PASSWORD });

    expect(envValue(yaml, 'MQTT_USERNAME')).toBe('mqtt');
  });

  it('marks only the supplied variable as explicit', async () => {
    const assembled = await assembleManifest({
      items: [{ name: 'mosquitto', checked: true }],
      prefilled: { MQTT_PASSWORD: NEW_PASSWORD },
    });

    expect(assembled.variables.find(v => v.name === 'MQTT_PASSWORD')?.explicit).toBe(true);
    expect(assembled.variables.find(v => v.name === 'MQTT_USERNAME')?.explicit).toBeUndefined();
  });
});

const secretVar = (name: string, value: string, explicit?: boolean): JobInputVariable => ({
  name,
  value,
  meta: { type: 'secret' },
  ...(explicit ? { explicit: true } : {}),
});

describe('reuseSavedSecrets — input outranks stored state (#2574)', () => {
  it('keeps an explicitly supplied value over the saved one and reports the rotation', () => {
    const vars = [secretVar('MQTT_PASSWORD', NEW_PASSWORD, true)];
    const reused = new Set<string>();

    const r = reuseSavedSecrets(vars, { MQTT_PASSWORD: OLD_PASSWORD }, reused, REDACTION_SENTINEL);

    expect(vars[0].value).toBe(NEW_PASSWORD);
    expect(r.rotatedNames).toEqual(['MQTT_PASSWORD']);
    expect(r.overrideNames).toEqual([]);
    // NOT recorded as reused: downstream self-heals (the Authelia storage-key
    // fingerprint check) treat "came from saved state" as "matches what is on
    // disk", which a rotated secret does not.
    expect(reused.has('MQTT_PASSWORD')).toBe(false);
  });

  it('still reuses the saved value when nothing was explicitly supplied', () => {
    const vars = [secretVar('MQTT_PASSWORD', 'stale-manifest-value')];
    const reused = new Set<string>();

    const r = reuseSavedSecrets(vars, { MQTT_PASSWORD: OLD_PASSWORD }, reused, REDACTION_SENTINEL);

    expect(vars[0].value).toBe(OLD_PASSWORD);
    expect(r.overrideNames).toEqual(['MQTT_PASSWORD']);
    expect(r.rotatedNames).toEqual([]);
    expect(reused.has('MQTT_PASSWORD')).toBe(true);
  });

  it('does not treat an explicit value that MATCHES the saved one as a rotation', () => {
    const vars = [secretVar('MQTT_PASSWORD', OLD_PASSWORD, true)];
    const reused = new Set<string>();

    const r = reuseSavedSecrets(vars, { MQTT_PASSWORD: OLD_PASSWORD }, reused, REDACTION_SENTINEL);

    expect(r.rotatedNames).toEqual([]);
    expect(reused.has('MQTT_PASSWORD')).toBe(true);
  });

  it('never lets "explicit" deploy the redaction mask (#2296 guard survives)', () => {
    const vars = [secretVar('MQTT_PASSWORD', REDACTION_SENTINEL, true)];
    const reused = new Set<string>();

    const r = reuseSavedSecrets(vars, { MQTT_PASSWORD: OLD_PASSWORD }, reused, REDACTION_SENTINEL);

    expect(vars[0].value).toBe(OLD_PASSWORD);
    expect(r.sentinelRestored).toEqual(['MQTT_PASSWORD']);
    expect(r.rotatedNames).toEqual([]);
  });

  it('rotates bcrypt and rsa-private secrets too, not just plain ones', () => {
    const vars: JobInputVariable[] = [
      { name: 'NGINX_ADMIN_HASH', value: '$2b$10$new', meta: { type: 'bcrypt' }, explicit: true },
      { name: 'OIDC_KEY', value: '-----BEGIN NEW KEY-----', meta: { type: 'rsa-private' }, explicit: true },
    ];

    const r = reuseSavedSecrets(
      vars,
      { NGINX_ADMIN_HASH: '$2b$10$old', OIDC_KEY: '-----BEGIN OLD KEY-----' },
      new Set(),
      REDACTION_SENTINEL,
    );

    expect(vars.map(v => v.value)).toEqual(['$2b$10$new', '-----BEGIN NEW KEY-----']);
    expect(r.rotatedNames).toEqual(['NGINX_ADMIN_HASH', 'OIDC_KEY']);
  });

  it('ignores the flag on a non-secret variable (reuse only ever touched secrets)', () => {
    const vars: JobInputVariable[] = [
      { name: 'MQTT_PORT', value: '1884', meta: { type: 'text' }, explicit: true },
    ];

    const r = reuseSavedSecrets(vars, { MQTT_PORT: '1883' }, new Set(), REDACTION_SENTINEL);

    expect(vars[0].value).toBe('1884');
    expect(r.rotatedNames).toEqual([]);
  });
});

describe('formatSecretRotationLog', () => {
  it('names the rotated variable and says the old credential stops working', () => {
    const line = formatSecretRotationLog(['MQTT_PASSWORD']);

    expect(line).toContain('MQTT_PASSWORD');
    expect(line).toContain('replaces the previously saved one');
    expect(line).toContain('rejected');
  });

  it('pluralises for several', () => {
    expect(formatSecretRotationLog(['A', 'B'])).toContain('2 secret variables (A, B)');
  });
});
