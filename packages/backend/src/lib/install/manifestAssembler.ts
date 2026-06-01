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
import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import yaml from 'js-yaml';
import {
  getTemplateYaml,
  getTemplateVariables,
  getTemplateConfigFiles,
  getTemplateAssetFiles,
  getTemplateSettingsSchema,
  type VariableMeta,
} from '@/lib/registry';
import { parseTemplateDependencies } from '@/lib/stackInstall/dependencies';
import { readManifestAnnotations } from '@/lib/template/contract';
import { generateRandomSecret } from '@/lib/stackInstall/randomSecret';
import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from './savedSecrets';
import type { JobInput, JobInputItem, JobInputVariable } from './jobStore';

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
   *  registry name. **Omit (undefined)** to walk every registry then fall
   *  back to built-in per template, which is what lets a single assemble
   *  call span multiple sources (#1177). A pinned `'Built-in'` skips the
   *  registry walk, so external-registry templates resolve to null. */
  templateSource?: string;
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
 * Cached result of {@link hostHasNvidiaCdi}. The marker file is dropped
 * once, at FCoS install time, so a per-process memoisation is safe — the
 * file's presence never flips during a ServiceBay lifecycle.
 */
let nvidiaCdiCache: boolean | null = null;

/**
 * Returns true when install-nvidia.sh stage 3 dropped its CDI-ready
 * marker file in ServiceBay's data dir (`/app/data/.has-nvidia-cdi`).
 * Used to flip OLLAMA_GPU_PASSTHROUGH's wizard default to "yes" on
 * hosts where the GPU is set up, so ollama runs on GPU without the
 * operator having to find the toggle.
 */
async function hostHasNvidiaCdi(): Promise<boolean> {
  if (nvidiaCdiCache !== null) return nvidiaCdiCache;
  try {
    await fs.access('/app/data/.has-nvidia-cdi');
    nvidiaCdiCache = true;
  } catch {
    nvidiaCdiCache = false;
  }
  return nvidiaCdiCache;
}

/**
 * Per-variable help text for well-known global variables that templates
 * reference but rarely declare a `description` for (so the wizard would
 * otherwise show a bare, unlabelled input). Keyed by variable name.
 */
const GLOBAL_VAR_HELP: Record<string, string> = {
  PUBLIC_DOMAIN:
    'Base public domain for this box (e.g. dopp.cloud). Services are ' +
    'exposed at <service>.<this domain>. Enter the bare domain, not a ' +
    'subdomain.',
};

/**
 * Ensure a variable carries help text so the wizard never renders a bare,
 * unlabelled input (#1252). Falls back to a known global hint
 * ({@link GLOBAL_VAR_HELP}) when `meta.description` is absent — e.g.
 * PUBLIC_DOMAIN, which templates reference for subdomain FQDNs but don't
 * declare a description for. Existing descriptions are left untouched.
 */
function withHelpText(
  name: string,
  meta: VariableMeta | undefined,
): VariableMeta | undefined {
  const help = GLOBAL_VAR_HELP[name];
  if (!help) return meta;
  if (meta?.description) return meta;
  return { ...(meta ?? {}), description: help };
}

/**
 * Assemble a stack-install manifest server-side.
 *
 * Faithful port of `useStackInstall.startConfigure`. The variable
 * resolution order, per variable, is:
 *   1. `prefilled[name]` (caller / baked config) — marks the var global
 *   2. `templateSettings[name]` (operator's Settings → Template Settings)
 *   3. `LLDAP_HOST` is always `localhost`
 *   4. `OLLAMA_GPU_PASSTHROUGH` → "yes" when `/app/data/.has-nvidia-cdi`
 *      exists (dropped by install-nvidia.sh stage 3)
 *   5. `meta.default`
 *   6. `secret` / `rsa-private` / `bcrypt` typed vars: reuse a saved
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
    }

    // Asset files (#1156) — a template's `skills/` subdirectory ships
    // to `{{DATA_DIR}}/<template>/skills/<relpath>` on the agent via
    // the same `extraFiles` transport. `renderContent: false` so
    // SKILL.md bodies aren't mangled by Mustache. No vars are
    // discovered from asset content for the same reason — they're
    // shipped verbatim.
    const assetFiles = await getTemplateAssetFiles(item.name, templateSource).catch(() => []);

    const allFiles = [...cfgFiles, ...assetFiles];
    if (allFiles.length > 0) {
      item.configFiles = allFiles.map(cf => ({
        filename: cf.filename,
        content: cf.content,
        targetPath: cf.targetPath,
        renderContent: cf.renderContent,
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
    // PUBLIC_DOMAIN is the box's base domain — already configured at
    // `config.reverseProxy.publicDomain` (set during onboarding / by the
    // baked config.json). Pre-fill from there so the operator isn't
    // re-typing a value the system already knows (#1252). Otherwise the
    // wizard surfaced PUBLIC_DOMAIN as a blank "Other" field, which is
    // exactly the value templates like OSCAR's ollama/hermes need for
    // their subdomain FQDNs.
    if (name === 'PUBLIC_DOMAIN' && !value && config.reverseProxy?.publicDomain) {
      value = config.reverseProxy.publicDomain;
      isGlobal = true;
    }
    if (name === 'LLDAP_HOST') {
      value = 'localhost';
      isGlobal = true;
    }
    // Default OLLAMA_GPU_PASSTHROUGH to "yes" on hosts where the FCoS
    // install layered the NVIDIA driver + CDI (install-nvidia.sh stage 3
    // drops `.has-nvidia-cdi` into ServiceBay's data dir). Without this
    // the wizard's prefilled default stays empty - ollama renders without
    // `resources.limits.nvidia.com/gpu: "1"` and runs on CPU even though
    // a working GPU is right there. Observed during the 2026-05-25 test:
    // gemma3:4b took ~8 s for a one-line response.
    if (name === 'OLLAMA_GPU_PASSTHROUGH' && !value && (await hostHasNvidiaCdi())) {
      value = 'yes';
    }
    if (!value && meta?.default) value = meta.default;

    if (!value && meta?.type === 'secret') {
      if (storedValues[name]) {
        value = storedValues[name];
      } else if (meta.noAutoGenerate) {
        // #1002 — Some `type: secret` variables are operator-supplied
        // externally (Telegram/Discord bot tokens, HA long-lived
        // token, etc.). Auto-generating them as random strings
        // creates garbage that the third-party service rejects on
        // every reconnect attempt. Leave empty; the consumer
        // post-deploy must handle absent values gracefully.
        value = '';
      } else {
        value = generateRandomSecret();
        newlyGenerated.push({ name, value });
      }
    }

    variables.push({ name, value, global: isGlobal, meta: withHelpText(name, meta) });
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

/**
 * #1297 — fill `variables.json` defaults into a JobInput for any template
 * variable that's missing or empty. The wizard path resolves defaults inside
 * `assembleManifest`; the **reinstall** path replays a saved JobInput verbatim
 * (`jobStore`), so a variable ADDED to a template *after* the manifest was
 * saved arrives empty and silently drops whatever depended on it (e.g. OSCAR's
 * `GATEKEEPER_MCP_URL`). Run at the install entry point (`/api/install/start`)
 * so every path — wizard and replayed reinstall — gets the same defaults
 * applied. A non-empty manifest value always wins; a default only fills a
 * missing/empty slot. Returns the input unchanged when nothing needed filling.
 */
export async function applyVariableDefaults(
  input: JobInput,
  templateSource?: string,
): Promise<JobInput> {
  // First template to declare a variable owns its default (mirrors
  // assembleManifest's grouping), so only record the first non-empty default.
  const defaults = new Map<string, string>();
  for (const item of input.items) {
    if (!item.checked || item.alreadyInstalled) continue;
    const meta = await getTemplateVariables(item.name, templateSource).catch(() => null);
    if (!meta) continue;
    for (const [name, m] of Object.entries(meta)) {
      if (m.default !== undefined && m.default !== '' && !defaults.has(name)) {
        defaults.set(name, m.default);
      }
    }
  }
  if (defaults.size === 0) return input;

  const next: JobInputVariable[] = input.variables.map(v => ({ ...v }));
  const indexByName = new Map(next.map((v, i) => [v.name, i]));
  let changed = false;
  for (const [name, def] of defaults) {
    const idx = indexByName.get(name);
    if (idx === undefined) {
      next.push({ name, value: def });
      changed = true;
    } else if (!next[idx].value) {
      next[idx].value = def;
      changed = true;
    }
  }
  return changed ? { ...input, variables: next } : input;
}
