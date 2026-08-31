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
import { DEVICE_SAFE_SECRET_LENGTH, generateRandomSecret } from '@/lib/stackInstall/randomSecret';
import { createToken, looksLikeApiToken } from '@/lib/auth/apiTokens';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { loadSavedSecrets, persistSingleSecret } from './savedSecrets';
import { loadSavedVariables } from './savedVariables';
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
  /**
   * #2537 — resolve only; never MINT credential material and never write.
   *
   * A read-only caller (the editor's "Re-render from template" preview) needs
   * the exact variable set a deploy would use, but must not have the side
   * effects a deploy has. Under `preview` the three generation branches
   * (random secret / RSA key / bcrypt hash) are skipped: a secret-typed
   * variable resolves from `installedSecrets` or stays EMPTY, and the caller
   * reports it as unresolved. That is deliberate — minting a fresh password
   * here would both write it to `installedSecrets` (diverging the store from
   * the running pod) and hand the operator a YAML that silently rotates a
   * live credential, which is the same class of harm as blanking it.
   *
   * With nothing generated, the trailing `persistSingleSecret` loop has
   * nothing to persist, so `preview` is write-free by construction.
   */
  preview?: boolean;
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
 * #2673 — mint the ServiceBay API token a `mintApiToken` secret asks for.
 *
 * The scope pair is fixed here rather than taken from the template: `read`
 * only, never expiring. That is the same combination
 * `neverExpiresScopesAreReadOnly` (`api/apiTokenRoutes.ts`) is the fail-closed
 * guard for on the operator-facing route — a non-expiring credential that
 * could mutate or destroy is a standing liability, so a template must not be
 * able to widen it by declaring a flag.
 *
 * Returns `''` when the mint fails. The caller then leaves the variable empty
 * (an unusable random string in a credential slot is the #1002 failure mode),
 * and the install continues — consumers of this flag already handle a blank.
 */
async function mintServicebayApiToken(varName: string, templateName?: string): Promise<string> {
  try {
    const { secret } = await createToken({
      // Named for what would break if it were revoked, so the row in
      // Settings → Tokens is self-explanatory.
      name: `${templateName ?? 'servicebay'} (${varName})`,
      scopes: ['read'],
      neverExpires: true,
      createdBy: 'servicebay-install',
    });
    return secret;
  } catch (e) {
    logger.warn(
      'install:manifestAssembler',
      `Could not mint the API token for ${varName}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return '';
  }
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
 * LAN-only fallback base DN (#2439). A box with no `PUBLIC_DOMAIN` still needs
 * a base DN to initialise LLDAP's tree with — every LDAP consumer (Authelia,
 * Radicale, Jellyfin's LDAP-Auth, claude-dev's nslcd) just has to agree with
 * it, so any self-consistent DN works. `dc=local` is chosen because `.local`
 * is reserved for link-local/LAN use (RFC 6762), so it can never collide with
 * a public domain the operator registers later. It is deliberately a FIXED
 * literal rather than derived from the box's hostname: the DN roots a stored
 * LDAP tree, and a hostname the operator renames would silently re-root it.
 */
const LAN_ONLY_BASE_DN = 'dc=local';

/**
 * Turn a bare public domain into an LDAP base DN — `example.com` →
 * `dc=example,dc=com` (#2439). Returns {@link LAN_ONLY_BASE_DN} when the box
 * has no public domain (LAN-only install). Tolerates the shapes an operator
 * can type into the domain field (scheme, trailing slash/dot, whitespace,
 * uppercase); anything left that is not a DNS label is dropped.
 */
export function deriveLdapBaseDn(publicDomain: string | undefined): string {
  const labels = (publicDomain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0]
    .split('.')
    .filter(l => /^[a-z0-9-]+$/.test(l));
  if (labels.length === 0) return LAN_ONLY_BASE_DN;
  return labels.map(l => `dc=${l}`).join(',');
}

/**
 * Per-variable help text for well-known global variables that templates
 * reference but rarely declare a `description` for (so the wizard would
 * otherwise show a bare, unlabelled input). Keyed by variable name.
 */
const GLOBAL_VAR_HELP: Record<string, string> = {
  PUBLIC_DOMAIN:
    'Base public domain for this box (e.g. example.com). Services are ' +
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

/** The per-template artifacts an install carries in its `JobInputItem`. */
interface TemplateArtifacts {
  yaml: string;
  dependencies: string[];
  /** Config files only — these are scanned for `{{VAR}}` references. */
  configFiles: { filename: string; content: string; targetPath?: string; renderContent?: boolean }[];
  /** Config files + asset files, in the order the item carries them. */
  allFiles: NonNullable<JobInputItem['configFiles']>;
}

/**
 * Read one template's deploy-time artifacts out of the registry: the pod
 * YAML, its declared install-time dependencies, its config files (with
 * `targetPath` resolved) and its asset files.
 *
 * Shared by {@link assembleManifest} (which resolves them when the manifest
 * is built) and {@link refreshTemplateArtifacts} (which re-resolves them at
 * deploy time, after the registry sync). Both MUST read the same way — a
 * divergence here means the deploy renders something the wizard never showed.
 * Returns null when the template can't be resolved from `templateSource`.
 */
async function resolveTemplateArtifacts(
  name: string,
  templateSource: string | undefined,
): Promise<TemplateArtifacts | null> {
  const yamlText = await getTemplateYaml(name, templateSource).catch(() => null);
  if (!yamlText) return null;

  // Install-time dependencies — parsed off the un-rendered yaml
  // (`servicebay.dependencies` has no Mustache placeholders).
  const dependencies = parseTemplateDependencies(yamlText);

  const cfgFiles = await getTemplateConfigFiles(name, templateSource).catch(() => []);
  if (cfgFiles.length > 0) resolveConfigFilePaths(yamlText, cfgFiles);

  // Asset files (#1156) — a template's `skills/` subdirectory ships
  // to `{{DATA_DIR}}/<template>/skills/<relpath>` on the agent via
  // the same `extraFiles` transport. `renderContent: false` so
  // SKILL.md bodies aren't mangled by Mustache. No vars are
  // discovered from asset content for the same reason — they're
  // shipped verbatim.
  const assetFiles = await getTemplateAssetFiles(name, templateSource).catch(() => []);

  const allFiles = [...cfgFiles, ...assetFiles].map(cf => ({
    filename: cf.filename,
    content: cf.content,
    targetPath: cf.targetPath,
    renderContent: cf.renderContent,
  }));
  return { yaml: yamlText, dependencies, configFiles: cfgFiles, allFiles };
}

/** One template's outcome from {@link refreshTemplateArtifacts}. */
export interface TemplateRefreshResult {
  /** Templates whose registry spec differs from the one in the manifest. */
  updated: string[];
  /** Templates that could no longer be resolved — manifest spec kept. */
  unresolved: string[];
}

/**
 * #2530 — re-resolve every deployable item's template artifacts from the
 * registry, in place, immediately after the install runner's `syncRegistries()`.
 *
 * Why this exists: `assembleManifest` reads `template.yml` when the MANIFEST is
 * built, and a reinstall of a saved manifest replays the YAML captured back
 * then. The registry pull (#1806) runs later, at the start of the deploy — so
 * the pod spec that actually gets rendered is always one sync behind the
 * registry, and a saved-manifest reinstall can be arbitrarily far behind. A
 * template block added since (an `env:` entry on a second container, a new
 * volume, a bumped image) is silently absent from the rendered pod YAML with no
 * error anywhere — exactly the reported symptom, and NOT the per-`(container,
 * name)` env dedupe the report guessed at: the renderer emits every occurrence
 * of a reused variable name faithfully, it was just handed a stale template.
 *
 * Only items that ALREADY carry a `yaml` are refreshed. An item without one was
 * deliberately skipped by the assembler (`alreadyInstalled`), and handing it a
 * spec here would make the runner deploy a service this run never intended to
 * touch.
 *
 * A template that can no longer be resolved is reported in `unresolved` and
 * keeps its manifest spec — the caller MUST surface that, since deploying a
 * spec we could not confirm is exactly the silent-staleness this fixes.
 */
export async function refreshTemplateArtifacts(
  items: JobInputItem[],
  templateSource?: string,
): Promise<TemplateRefreshResult> {
  const updated: string[] = [];
  const unresolved: string[] = [];
  for (const item of items) {
    if (!item.checked || !item.yaml) continue;
    let artifacts = await resolveTemplateArtifacts(item.name, templateSource);
    // A pinned source that no longer carries the template (renamed registry,
    // a manifest that recorded the defaulted 'Built-in' for an external
    // template) — walk every source rather than deploy the stale spec.
    if (!artifacts && templateSource) {
      artifacts = await resolveTemplateArtifacts(item.name, undefined);
    }
    if (!artifacts) {
      unresolved.push(item.name);
      continue;
    }
    if (artifacts.yaml !== item.yaml) updated.push(item.name);
    item.yaml = artifacts.yaml;
    item.dependencies = artifacts.dependencies;
    if (artifacts.allFiles.length > 0) item.configFiles = artifacts.allFiles;
    else delete item.configFiles;
  }
  return { updated, unresolved };
}

/**
 * Assemble a stack-install manifest server-side.
 *
 * Faithful port of `useStackInstall.startConfigure`. The variable
 * resolution order, per variable, is:
 *   1. `prefilled[name]` (caller / baked config) — marks the var global AND
 *      `explicit` (#2574): a value supplied for this run outranks stored
 *      state, so the runner's saved-secret reuse leaves it alone. Without
 *      that marker a supplied secret was silently replaced by the saved one
 *      and no service password could be rotated.
 *   2. `templateSettings[name]` (operator's Settings → Template Settings)
 *   3. `LLDAP_HOST` is always `localhost`
 *   4. `OLLAMA_GPU_PASSTHROUGH` → "yes" when `/app/data/.has-nvidia-cdi`
 *      exists (dropped by install-nvidia.sh stage 3)
 *   5. `meta.default`
 *   6. `secret` / `rsa-private` / `bcrypt` typed vars: reuse a saved
 *      value when one exists, else generate (and persist) a fresh one
 *   7. derived-from-another-variable vars, applied only when still empty:
 *      `VAULTWARDEN_DOMAIN` (subdomain + public domain) and
 *      `LLDAP_BASE_DN` ({@link deriveLdapBaseDn} of the public domain)
 */
export async function assembleManifest(
  input: AssembleManifestInput,
): Promise<AssembledManifest> {
  const { templateSource } = input;
  const prefilled = input.prefilled ?? {};
  // #2537 — read-only resolve: no new credential material, no config write.
  const preview = input.preview === true;

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
  // Operator-set non-secret values from the last install (#2531) — the
  // non-secret twin of `storedValues`. Without it a `text` variable the
  // operator typed and that has no default came back empty on every
  // reinstall, with no error.
  const savedVariables: Record<string, string> = loadSavedVariables(config);

  const vars = new Set<string>();
  const allMeta: Record<string, VariableMeta> = {};

  for (const item of selected) {
    const artifacts = await resolveTemplateArtifacts(item.name, templateSource);
    if (!artifacts) continue;
    const templateYaml = artifacts.yaml;
    item.yaml = templateYaml;
    item.dependencies = artifacts.dependencies;

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

    for (const cf of artifacts.configFiles) {
      for (const m of cf.content.matchAll(MUSTACHE_VAR_RE)) vars.add(m[1]);
    }

    if (artifacts.allFiles.length > 0) item.configFiles = artifacts.allFiles;
  }

  // Variables declared via metadata but never referenced in YAML
  // (e.g. subdomain vars used only for proxy-host configuration).
  for (const key of Object.keys(allMeta)) vars.add(key);

  // #2144 — A `type: subdomain` variable needs PUBLIC_DOMAIN to form its
  // FQDN (`buildProxyHosts` reads it). PUBLIC_DOMAIN is otherwise injected
  // only when a template's YAML references `{{PUBLIC_DOMAIN}}`; a template
  // that declares a subdomain var but never references PUBLIC_DOMAIN got
  // `domain=undefined` → the proxy host was silently skipped. Auto-inject it
  // whenever any subdomain var exists so the route is always created (the
  // value is resolved from config.reverseProxy.publicDomain in the loop
  // below, exactly as a referenced PUBLIC_DOMAIN would be).
  const hasSubdomainVar = Object.values(allMeta).some(m => m.type === 'subdomain');
  if (hasSubdomainVar) vars.add('PUBLIC_DOMAIN');

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
    // #2574 — the caller SUPPLIED this value for this run (MCP
    // `install_template({variables})`, `/api/install/assemble` prefilled, a
    // baked first-boot config). That is the statement that whatever is stored
    // should stop applying, so the runner's saved-secret reuse must not
    // overwrite it. Only the `prefilled` branch sets it: `templateSettings`
    // and the derived/defaulted branches below are stored state themselves.
    let isExplicit = false;

    if (Object.prototype.hasOwnProperty.call(prefilled, name) && prefilled[name]) {
      value = prefilled[name];
      isGlobal = true;
      isExplicit = true;
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
    // #2531 — a value the operator set on a previous install outranks the
    // template default. Only genuinely operator-set values are stored (see
    // savedVariables.ts), so a template that BUMPS a default still reaches a
    // box that never overrode it — the #1297 contract is preserved.
    if (!value && savedVariables[name]) value = savedVariables[name];
    if (!value && meta?.default) value = meta.default;

    if (!value && meta?.type === 'secret') {
      // #2711 — a stored value is reused as-is EXCEPT when the variable asks
      // for a real ServiceBay API token and what is stored is not one.
      //
      // The reuse rule and the mint rule (#2673) collided silently: reuse is
      // checked first and matches *any* stored string, so a service that was
      // installed before `mintApiToken` existed carries the 32-character random
      // secret that install generated, and every later deploy hands that same
      // non-token back. The mint branch is never entered, so minting only ever
      // helped FRESH installs — the existing service keeps a value that 401s on
      // every call, forever, with nothing saying why (measured on a real box:
      // no minted token row existed for a service whose template declares the
      // flag). Re-minting when the stored value has no token shape closes that
      // without touching #2673's idempotency: a well-formed stored token is
      // still reused, so a re-install still accumulates no orphaned tokens.
      const stored = storedValues[name];
      const storedIsUsable = !!stored && (!meta.mintApiToken || looksLikeApiToken(stored));
      if (stored && !storedIsUsable) {
        // Length only. A credential slot's contents never reach a log line,
        // and "it is 32 characters, not an sb_ token" is the whole diagnosis.
        logger.warn(
          'install:manifestAssembler',
          `Stored value for ${name} is not a ServiceBay API token (${stored.length} characters); minting a replacement.`,
        );
      }
      if (storedIsUsable) {
        value = stored;
      } else if (preview || meta.noAutoGenerate) {
        // `preview` (#2537): the store had nothing, so this value is genuinely
        // unresolvable. Leave it empty and let the caller SAY SO rather than
        // mint a replacement credential in a read-only path.
        // #1002 — Some `type: secret` variables are operator-supplied
        // externally (Telegram/Discord bot tokens, HA long-lived
        // token, etc.). Auto-generating them as random strings
        // creates garbage that the third-party service rejects on
        // every reconnect attempt. Leave empty; the consumer
        // post-deploy must handle absent values gracefully.
        value = '';
      } else if (meta.mintApiToken) {
        // #2673 — the variable wants a ServiceBay API token, not a random
        // string. Mint a real one so the consumer works with no operator
        // step. A mint failure leaves the value EMPTY rather than falling
        // back to a random string: an unusable credential is exactly the
        // #1002 failure mode, and every consumer of this flag already has
        // to handle the blank case (an operator can decline to supply one).
        value = await mintServicebayApiToken(name, meta.templateName);
        if (value) newlyGenerated.push({ name, value });
      } else {
        // #2577 — a `deviceSafe` secret is one the operator retypes into a
        // device's own credential field, which commonly caps its length and
        // keeps the prefix; the device then reports a perfectly correct
        // password as "wrong". Generate it shorter (still alphanumeric, like
        // every other secret) so it survives the trip.
        value = generateRandomSecret(meta.deviceSafe ? DEVICE_SAFE_SECRET_LENGTH : undefined);
        newlyGenerated.push({ name, value });
      }
    }

    variables.push({
      name,
      value,
      global: isGlobal,
      meta: withHelpText(name, meta),
      ...(isExplicit ? { explicit: true } : {}),
    });
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
    if (preview) continue; // #2537 — never mint a key in a read-only resolve.
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
    if (preview) continue; // #2537 — a fresh hash is fresh credential material.
    const sourceName = meta?.bcryptSource;
    if (!sourceName) continue;
    const source = variables.find(x => x.name === sourceName);
    if (!source?.value) continue;
    v.value = await bcrypt.hash(source.value, 10);
    newlyGenerated.push({ name: v.name, value: v.value });
  }

  // VAULTWARDEN_DOMAIN derives from the subdomain + public domain.
  const pubDomain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;

  // LLDAP_BASE_DN derives from the same public domain (#2439) — the four
  // LDAP-consuming templates used to ship the maintainer's own DN as their
  // default. Fill ONLY when the value is still empty, so a box that already
  // has a base DN (prefilled, Template Settings, or a replayed manifest)
  // keeps it: the DN roots an existing LDAP tree, and overwriting it would
  // silently re-root every user and group on the next redeploy.
  // `global` is deliberately NOT set: unlike VAULTWARDEN_DOMAIN this stays an
  // editable wizard field, so an operator joining an LLDAP tree that was
  // initialised with a different DN can correct the derived value in place.
  const baseDn = variables.find(v => v.name === 'LLDAP_BASE_DN');
  if (baseDn && !baseDn.value) {
    // Read the box's domain from config too, not just the PUBLIC_DOMAIN
    // variable: that variable only joins `variables` when some selected
    // template references it or declares a subdomain, so a stack like
    // claude-dev (LDAP consumer, no proxy host) would otherwise fall back to
    // the LAN DN on a box that does have a public domain — and disagree with
    // the DN the `auth` stack initialised LLDAP with.
    baseDn.value = deriveLdapBaseDn(pubDomain || config.reverseProxy?.publicDomain);
  }
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
 *
 * #2531 — the same slot-filling now also restores values the OPERATOR set on a
 * previous install (`config.installedVariables`), which outrank the template
 * default. This is the end-to-end point: it runs for the MCP `install_template`
 * path and for `POST /api/install/start`, including the reinstall that replays
 * a saved JobInput and never touches `assembleManifest`.
 */
/**
 * `varName → value` to fill into any missing/empty slot of a JobInput, for the
 * templates this install actually deploys.
 *
 * Precedence: an operator-set value from a previous install (#2531) outranks
 * the template's `variables.json` default (#1297) — both only ever fill a gap,
 * so a value the manifest already carries wins over either.
 */
async function collectVariableFills(
  items: JobInputItem[],
  templateSource: string | undefined,
): Promise<Map<string, string>> {
  // First template to declare a variable owns its default (mirrors
  // assembleManifest's grouping), so only record the first non-empty default.
  const defaults = new Map<string, string>();
  const declared = new Set<string>();
  for (const item of items) {
    if (!item.checked || item.alreadyInstalled) continue;
    const meta = await getTemplateVariables(item.name, templateSource).catch(() => null);
    if (!meta) continue;
    for (const [name, m] of Object.entries(meta)) {
      declared.add(name);
      if (m.default !== undefined && m.default !== '' && !defaults.has(name)) {
        defaults.set(name, m.default);
      }
    }
  }

  const cfg = await getConfig().catch(() => null);
  const savedVariables = cfg ? loadSavedVariables(cfg) : {};
  const fills = new Map<string, string>();
  for (const name of declared) {
    if (savedVariables[name]) fills.set(name, savedVariables[name]);
  }
  for (const [name, def] of defaults) {
    if (!fills.has(name)) fills.set(name, def);
  }
  return fills;
}

export async function applyVariableDefaults(
  input: JobInput,
  templateSource?: string,
): Promise<JobInput> {
  const fills = await collectVariableFills(input.items, templateSource);

  const next: JobInputVariable[] = input.variables.map(v => ({ ...v }));
  const indexByName = new Map(next.map((v, i) => [v.name, i]));
  let changed = false;
  for (const [name, fill] of fills) {
    const idx = indexByName.get(name);
    if (idx === undefined) {
      next.push({ name, value: fill });
      changed = true;
    } else if (!next[idx].value) {
      next[idx].value = fill;
      changed = true;
    }
  }

  if (await fillDerivedBaseDn(next)) changed = true;
  return changed ? { ...input, variables: next } : input;
}

/**
 * #2439 — LLDAP_BASE_DN has no `variables.json` default to fall back on any
 * more; it is derived from the public domain. A manifest replayed from before
 * the variable existed would therefore reach the deploy empty, and an empty
 * base DN renders an Authelia/Radicale config that binds against nothing. Fill
 * it at the install entry point too, under the same "only when empty" rule so
 * an installed stack's DN is never re-rooted. Mutates `vars` in place and
 * returns whether it changed anything. Only an EXISTING empty slot is filled —
 * never appended, so a stack with no LDAP variable stays untouched.
 */
async function fillDerivedBaseDn(vars: JobInputVariable[]): Promise<boolean> {
  const dn = vars.find(v => v.name === 'LLDAP_BASE_DN');
  if (!dn || dn.value) return false;
  const cfg = await getConfig().catch(() => null);
  dn.value = deriveLdapBaseDn(cfg?.reverseProxy?.publicDomain);
  return true;
}
