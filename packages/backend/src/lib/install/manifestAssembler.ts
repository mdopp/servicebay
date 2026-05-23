/**
 * Server-side stack-install manifest assembler (#800).
 *
 * Turns a template selection plus baked / operator-supplied config into
 * a concrete `JobInput` (items + variables) ready to hand to
 * `/api/install/start`.
 *
 * This logic used to live ONLY in the browser
 * (`packages/frontend/src/hooks/useStackInstall.ts:startConfigure`),
 * which meant stack setup could not run headless: `install-fedora-
 * coreos.sh` bakes `config.json` into the ISO, but post-boot there was
 * no API / CLI path to turn "install these templates with these
 * defaults" into a `JobInput` — only the browser wizard could build
 * one. `POST /api/install/start` just validates a pre-built `JobInput`
 * and runs the deploy loop; nothing on the backend could *produce* one.
 *
 * Behaviour is a faithful port of `startConfigure`: identical variable-
 * resolution precedence, identical secret / RSA-key / bcrypt generation,
 * identical config-file `targetPath` resolution. The wizard keeps every
 * screen and behaviour it has today — it just calls the backend
 * assembler instead of assembling the manifest inline.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import yaml from 'js-yaml';
import {
  getTemplateYaml,
  getTemplateVariables,
  getTemplateConfigFiles,
  getTemplateSettingsSchema,
  type VariableMeta,
} from '@/lib/registry';
import { parseTemplateDependencies } from '@/lib/stackInstall/dependencies';
import { readManifestAnnotations } from '@/lib/template/contract';
import { generateRandomSecret } from '@/lib/stackInstall/randomSecret';
import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from './savedSecrets';
import type { JobInputItem, JobInputVariable } from './jobStore';

/** A template the caller wants installed. Mirrors the wizard's
 *  `StackItemInput`. */
export interface AssembleItemInput {
  name: string;
  checked: boolean;
  alreadyInstalled?: boolean;
}

export interface AssembleManifestInput {
  /** Templates to assemble a manifest for. */
  items: AssembleItemInput[];
  /** Caller-supplied variable values that win over template defaults
   *  and `templateSettings` globals — e.g. `PUBLIC_DOMAIN`,
   *  `NGINX_ADMIN_EMAIL`. The wizard captures these on earlier screens;
   *  the headless path reads them from the baked `config.json`. */
  prefilled?: Record<string, string>;
  /** Template source — `'Built-in'` for the bundled catalogue, or a
   *  registry name. */
  templateSource: string;
}

export interface AssembledManifest {
  items: JobInputItem[];
  variables: JobInputVariable[];
}

/** `{{VAR}}` placeholders — the variable references we have to resolve. */
const MUSTACHE_VAR_RE = /\{\{\s*([\w\d_]+)\s*\}\}/g;
/** Mustache section tags (`{{#X}}` / `{{^X}}` / `{{/X}}`) — stripped
 *  before js-yaml parses the pod spec for volume mounts. */
const MUSTACHE_SECTION_RE = /\{\{\s*[#^/]\s*[\w\d_]+\s*\}\}/g;
const SBVAR_SENTINEL_OUT = /\{\{\s*([\w\d_]+)\s*\}\}/g;
const SBVAR_SENTINEL_IN = /__SBVAR_([\w\d_]+)__/g;

/** Resolve each config file's on-disk `targetPath` by parsing the YAML
 *  pod spec for the volume / volumeMount that backs the config mount.
 *  Pure port of `useStackInstall.resolveConfigFilePaths`. */
function resolveConfigFilePaths(
  templateYaml: string,
  cfgFiles: { filename: string; content: string; targetPath?: string }[],
): void {
  if (cfgFiles.length === 0) return;
  // Mustache placeholders trip js-yaml ('missed comma between flow
  // collection entries'); swap them for a parseable sentinel, strip
  // section tags entirely, then restore after parsing.
  const safeYaml = templateYaml
    .replace(MUSTACHE_SECTION_RE, '')
    .replace(SBVAR_SENTINEL_OUT, (_m, n) => `__SBVAR_${n}__`);
  const restore = (s: string): string =>
    s.replace(SBVAR_SENTINEL_IN, (_m, n) => `{{${n}}}`);

  let docs: unknown[] = [];
  try {
    docs = yaml.loadAll(safeYaml);
  } catch {
    docs = [];
  }
  const doc = docs.find(
    (d): d is Record<string, unknown> =>
      !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === 'Pod',
  ) ?? (docs[0] as Record<string, unknown> | undefined);
  const spec = (doc?.spec ?? {}) as {
    volumes?: { name?: string; hostPath?: { path?: string } }[];
    containers?: { volumeMounts?: { mountPath?: string; name?: string }[] }[];
  };
  const nameToHostPath = new Map<string, string>();
  for (const v of spec.volumes ?? []) {
    if (typeof v?.name === 'string' && typeof v?.hostPath?.path === 'string') {
      nameToHostPath.set(v.name, restore(v.hostPath.path));
    }
  }
  const mountPathToHostPath = new Map<string, string>();
  for (const c of spec.containers ?? []) {
    for (const m of c?.volumeMounts ?? []) {
      if (typeof m?.mountPath === 'string' && typeof m?.name === 'string') {
        const hp = nameToHostPath.get(m.name);
        if (hp && !mountPathToHostPath.has(m.mountPath)) {
          mountPathToHostPath.set(m.mountPath, hp);
        }
      }
    }
  }
  const annotations = ((doc?.metadata as { annotations?: Record<string, string> } | undefined)
    ?.annotations) ?? {};
  const explicitMount = annotations['servicebay.config-mount'];
  for (const cf of cfgFiles) {
    let hp: string | undefined;
    if (explicitMount) hp = mountPathToHostPath.get(explicitMount);
    if (!hp) {
      for (const [mp, h] of mountPathToHostPath.entries()) {
        if (mp === '/config' || mp.endsWith('/config') || mp.endsWith('/conf')) {
          hp = h;
          break;
        }
      }
    }
    if (hp) cf.targetPath = `${hp}/${cf.filename}`;
  }
}

/** Generate a fresh 2048-bit RSA private key, PEM-encoded and indented
 *  for a YAML block scalar (Authelia's OIDC JWKS key). Matches the
 *  shape `useStackInstall` produced from `/api/system/keys/rsa`. */
function generateRsaPrivateKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return privateKey
    .trimEnd()
    .split('\n')
    .map(line => '          ' + line)
    .join('\n');
}

/**
 * Assemble a stack-install manifest server-side.
 *
 * Faithful port of `useStackInstall.startConfigure`. The variable
 * resolution order, per variable, is:
 *   1. `prefilled[name]` (caller / baked config) — marks the var global
 *   2. `templateSettings[name]` (operator's Settings → Template Settings)
 *   3. `LLDAP_HOST` is always `localhost`
 *   4. `meta.default`
 *   5. `secret` / `rsa-private` / `bcrypt` typed vars: reuse a saved
 *      value when one exists, else generate (and persist) a fresh one
 */
export async function assembleManifest(
  input: AssembleManifestInput,
): Promise<AssembledManifest> {
  const { templateSource } = input;
  const prefilled = input.prefilled ?? {};

  const items: JobInputItem[] = input.items.map(i => ({
    name: i.name,
    checked: i.checked,
    alreadyInstalled: i.alreadyInstalled,
  }));
  const selected = items.filter(i => i.checked && !i.alreadyInstalled);

  const config = await getConfig();
  const globalSettings: Record<string, string> = config.templateSettings ?? {};
  // Saved secret values — reused so a service with a pre-existing data
  // volume keeps the password it was initialised with (#615).
  const storedValues: Record<string, string> = loadSavedSecrets(config);

  const vars = new Set<string>();
  const allMeta: Record<string, VariableMeta> = {};

  for (const item of selected) {
    const templateYaml = await getTemplateYaml(item.name, templateSource).catch(() => null);
    if (!templateYaml) continue;
    item.yaml = templateYaml;

    // Install-time dependencies — parsed off the un-rendered yaml
    // (`servicebay.dependencies` has no Mustache placeholders).
    item.dependencies = parseTemplateDependencies(templateYaml);

    for (const m of templateYaml.matchAll(MUSTACHE_VAR_RE)) vars.add(m[1]);

    const templateLabel = readManifestAnnotations(templateYaml).label ?? item.name;
    const meta = await getTemplateVariables(item.name, templateSource).catch(() => null);
    if (meta) {
      // First template to declare a variable owns it for grouping —
      // shared vars (LLDAP_HOST, …) live under their originator.
      for (const [key, value] of Object.entries(meta)) {
        if (!allMeta[key]) {
          allMeta[key] = { ...value, templateName: item.name, templateLabel };
        }
      }
    }

    const cfgFiles = await getTemplateConfigFiles(item.name, templateSource).catch(() => []);
    if (cfgFiles.length > 0) {
      resolveConfigFilePaths(templateYaml, cfgFiles);
      for (const cf of cfgFiles) {
        for (const m of cf.content.matchAll(MUSTACHE_VAR_RE)) vars.add(m[1]);
      }
      item.configFiles = cfgFiles.map(cf => ({
        filename: cf.filename,
        content: cf.content,
        targetPath: cf.targetPath,
      }));
    }
  }

  // Variables declared via metadata but never referenced in YAML
  // (e.g. subdomain vars used only for proxy-host configuration).
  for (const key of Object.keys(allMeta)) vars.add(key);

  // Secret-typed values generated fresh in THIS run — persisted before
  // returning so a mid-install failure doesn't strand a value that
  // exists only in this manifest (#622).
  const newlyGenerated: { name: string; value: string }[] = [];

  // Merge global settings schema variables into allMeta so their defaults
  // are respected if not prefilled.
  const globalSchema = await getTemplateSettingsSchema().catch(() => ({}));
  for (const [key, val] of Object.entries(globalSchema)) {
    if (!allMeta[key]) {
      allMeta[key] = {
        type: 'text',
        default: val.default,
        description: val.description,
        templateName: 'global',
        templateLabel: 'Global Settings',
      };
    }
  }

  const variables: JobInputVariable[] = [];
  vars.delete('LLDAP_FORCE_LDAP_USER_PASS_RESET');
  for (const name of vars) {
    const meta = allMeta[name];
    let value = '';
    let isGlobal = false;

    if (Object.prototype.hasOwnProperty.call(prefilled, name) && prefilled[name]) {
      value = prefilled[name];
      isGlobal = true;
    } else if (globalSettings[name]) {
      value = globalSettings[name];
      isGlobal = true;
    }
    if (name === 'LLDAP_HOST') {
      value = 'localhost';
      isGlobal = true;
    }
    if (!value && meta?.default) value = meta.default;

    if (!value && meta?.type === 'secret') {
      if (storedValues[name]) {
        value = storedValues[name];
      } else {
        value = generateRandomSecret();
        newlyGenerated.push({ name, value });
      }
    }

    variables.push({ name, value, global: isGlobal, meta });
  }

  // RSA private keys — reuse a stored key over generating a new one
  // (OIDC tokens signed under the prior key would otherwise be
  // rejected by clients pinned to it).
  for (const v of variables) {
    if (v.value || (v.meta as VariableMeta | undefined)?.type !== 'rsa-private') continue;
    if (storedValues[v.name]) {
      v.value = storedValues[v.name];
      continue;
    }
    v.value = generateRsaPrivateKeyPem();
    newlyGenerated.push({ name: v.name, value: v.value });
  }

  // Bcrypt hashes derive from another variable's plaintext — runs
  // after the secret pass so the source value is already populated.
  for (const v of variables) {
    const meta = v.meta as VariableMeta | undefined;
    if (v.value || meta?.type !== 'bcrypt') continue;
    if (storedValues[v.name]) {
      v.value = storedValues[v.name];
      continue;
    }
    const sourceName = meta?.bcryptSource;
    if (!sourceName) continue;
    const source = variables.find(x => x.name === sourceName);
    if (!source?.value) continue;
    v.value = await bcrypt.hash(source.value, 10);
    newlyGenerated.push({ name: v.name, value: v.value });
  }

  // VAULTWARDEN_DOMAIN derives from the subdomain + public domain.
  const pubDomain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
  const vwSub = variables.find(v => v.name === 'VAULTWARDEN_SUBDOMAIN')?.value;
  if (pubDomain && vwSub) {
    const vwDomain = variables.find(v => v.name === 'VAULTWARDEN_DOMAIN');
    if (vwDomain) {
      vwDomain.value = `https://${vwSub}.${pubDomain}`;
      vwDomain.global = true;
    }
  }

  // Persist every newly-generated secret before returning. Best-effort:
  // the install runner's end-of-install `persistInstalledSecrets` is the
  // safety net if a write here fails.
  for (const { name, value } of newlyGenerated) {
    await persistSingleSecret(name, value).catch(() => undefined);
  }

  return { items, variables };
}
