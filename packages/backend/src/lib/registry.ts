
import fs from 'fs/promises';
import path from 'path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'util';
import { getConfig, RegistryConfig } from './config';
import { readManifestAnnotations } from './template/contract';
import { parseStackManifest, type StackManifest } from './template/stackContract';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');
const STACKS_PATH = path.join(process.cwd(), 'stacks');
const CONTAINER_CONFIG_DIR = '/app/.servicebay';
const REGISTRIES_DIR = path.join(
  process.env.CONTAINER_CONFIG_DIR || CONTAINER_CONFIG_DIR,
  'registries'
);

// Default registry: the ServiceBay repo itself (public, no auth needed)
const DEFAULT_REGISTRY: RegistryConfig = {
  name: 'servicebay',
  url: 'https://github.com/mdopp/servicebay.git',
};

export interface Template {
  name: string;
  path: string;
  url: string;
  type: 'template' | 'stack';
  source: string;
  /**
   * Platform vs feature classification. Read from each template.yml's
   * `metadata.annotations['servicebay.tier']`. `undefined` for stacks
   * and for templates without the annotation (treated as 'feature' by
   * the wizard). See `src/lib/templateTier.ts`.
   */
  tier?: 'infrastructure' | 'feature';
  /**
   * Install-time hard dependencies. Read from
   * `metadata.annotations['servicebay.dependencies']` — comma-separated
   * list of template names that must install before this one. Used by
   * the wizard to auto-check deps + block unchecking a dep that
   * something else needs, and by `useStackInstall` to topo-sort the
   * deploy loop. Empty for stacks and for templates without the
   * annotation.
   */
  dependencies?: string[];
}

export interface TemplateSettingsSchemaEntry {
    default: string;
    description?: string;
    required?: boolean;
}

const DEFAULT_TEMPLATE_SCHEMA: Record<string, TemplateSettingsSchemaEntry> = {
    DATA_DIR: {
        default: '/mnt/data',
        description: 'Base directory used by templates for persistent data',
        required: true
    }
};

export async function getTemplateSettingsSchema(): Promise<Record<string, TemplateSettingsSchemaEntry>> {
    const settingsPath = path.join(TEMPLATES_PATH, 'settings.json');
    try {
        const raw = await fs.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const variables = parsed?.variables || {};
        return {
            ...DEFAULT_TEMPLATE_SCHEMA,
            ...variables
        };
    } catch {
        return DEFAULT_TEMPLATE_SCHEMA;
    }
}

/**
 * Read `tier` + `dependencies` from a template.yml in one shot. Returns
 * empty/default values on any failure (missing file, unparseable YAML,
 * missing annotation) — matches the wizard's default-to-feature rule
 * and keeps a malformed template visible-but-warned rather than
 * mysteriously absent. Stacks have no manifest annotations.
 *
 * Delegates to the unified parser in `src/lib/template/contract.ts`
 * (#585). Loose-mode (`readManifestAnnotations`) is the right path here:
 * we want to surface whatever annotations the template provides without
 * blocking the entire registry sync on a missing `servicebay.label`.
 * The build-time consistency suite calls the strict parser to catch
 * bundled-template defects loudly.
 */
async function readTemplateMeta(
  itemDir: string,
  type: 'template' | 'stack',
  name: string,
  source: string,
): Promise<{ tier?: 'infrastructure' | 'feature'; dependencies: string[] }> {
  if (type === 'stack') {
    // Stacks today are READMEs (`stacks/ai-stack/`, `stacks/full-stack/`).
    // From #624 onward they MAY ship a `stack.yml` whose `servicebay.tier`
    // annotation (`core` | `feature`) maps onto the existing template
    // tier surface. README-only stacks keep returning empty meta — the
    // wizard treats absence as "feature, no deps", same as before.
    try {
      const manifest = await getStackManifest(name, source);
      if (manifest) {
        return {
          // `core` stacks present as `infrastructure` in the wizard's
          // current shape — same gate as platform templates (auto-checked,
          // can't be opted out of). Phase 5 introduces the explicit `core`
          // tier; until then this mapping keeps the legacy UI behaviour.
          tier: manifest.tier === 'core' ? 'infrastructure' : 'feature',
          dependencies: manifest.dependsOnStacks,
        };
      }
    } catch (e) {
      // A malformed stack.yml shouldn't drop the stack from the registry
      // listing — surface defaults so the operator still sees the stack
      // (with a broken-manifest warning the consistency lint will catch
      // at build time).
      console.warn(`[registry] failed to load stack manifest for ${name}:`, e);
    }
    return { tier: undefined, dependencies: [] };
  }
  try {
    const yaml = await fs.readFile(path.join(itemDir, 'template.yml'), 'utf-8');
    const annotations = readManifestAnnotations(yaml);
    return {
      tier: annotations.tier ?? 'feature',
      dependencies: annotations.dependencies ?? [],
    };
  } catch {
    return { tier: 'feature', dependencies: [] };
  }
}

async function fetchDir(dirPath: string, type: 'template' | 'stack', source: string): Promise<Template[]> {
  try {
    // Check if directory exists
    try {
        await fs.access(dirPath);
    } catch {
        return [];
    }

    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const directories = items.filter(item => item.isDirectory() && !item.name.startsWith('.'));

    return await Promise.all(directories.map(async item => {
        const itemPath = path.join(dirPath, item.name);
        const { tier, dependencies } = await readTemplateMeta(itemPath, type, item.name, source);
        return {
            name: item.name,
            path: itemPath,
            url: '', // No URL for local files
            type,
            source,
            tier,
            dependencies,
        };
    }));
  } catch (e) {
      console.error(`Error fetching ${type}s from ${source}:`, e);
      return [];
  }
}

function getRegistries(config: Awaited<ReturnType<typeof getConfig>>): RegistryConfig[] {
    let registries: RegistryConfig[] = [];

    if (Array.isArray(config.registries)) {
        registries = config.registries;
    } else if (config.registries?.enabled) {
        registries = config.registries.items || [];
    }

    // Always include the default registry if not already present
    if (!registries.some(r => r.name === DEFAULT_REGISTRY.name)) {
        registries = [DEFAULT_REGISTRY, ...registries];
    }

    return registries;
}

async function cloneSparse(url: string, dest: string, dirs: string[]) {
    // Shallow clone with sparse checkout — only pull the directories we need
    await execFileAsync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, dest]);
    await execFileAsync('git', ['sparse-checkout', 'set', ...dirs], { cwd: dest });
}

let gitAvailability: boolean | null = null;
async function isGitAvailable(): Promise<boolean> {
    if (gitAvailability !== null) return gitAvailability;
    try {
        await execFileAsync('git', ['--version']);
        gitAvailability = true;
    } catch {
        gitAvailability = false;
    }
    return gitAvailability;
}

export async function syncRegistries() {
    const config = await getConfig();
    const registries = getRegistries(config);

    if (registries.length === 0) return;

    // The official ServiceBay container bundles git (#443). This guard
    // stays for unofficial runtime environments — without git we can
    // still serve the built-in templates/stacks bundled with
    // ServiceBay; only external registry sync is unavailable. Log once
    // and skip rather than fail every server start.
    if (!(await isGitAvailable())) {
        console.log('Registry sync skipped: git not available (built-in templates still served).');
        return;
    }

    try {
        await fs.mkdir(REGISTRIES_DIR, { recursive: true });
    } catch {}

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        // Isolate each registry: a single bad URL (a 404'd repo, an
        // unreachable mirror) used to abort the entire loop, so the
        // registries listed *after* it never got synced — which is why
        // a stale `ServiceBay Templates` entry could silently strand
        // the canonical `mdopp/servicebay` clone. Per-registry try/catch
        // keeps subsequent registries syncing.
        try {
            try {
                await fs.access(path.join(regPath, '.git'));
                // Exists — fetch latest and reset (shallow clones can't reliably git pull)
                console.log(`Updating registry ${reg.name}...`);
                const branch = reg.branch || 'main';
                await execAsync(`git fetch --depth 1 origin ${branch}`, { cwd: regPath });
                await execAsync(`git reset --hard origin/${branch}`, { cwd: regPath });
            } catch {
                // Doesn't exist, clone
                console.log(`Cloning registry ${reg.name}...`);
                try {
                    await cloneSparse(reg.url, regPath, ['templates', 'stacks']);
                } catch {
                    // Fallback to full clone if sparse checkout not supported
                    await execFileAsync('git', ['clone', '--depth', '1', reg.url, regPath]);
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`Registry ${reg.name} (${reg.url}) sync failed — skipping (other registries continue): ${msg}`);
        }
    }
}

export async function getTemplates(): Promise<Template[]> {
    // 1. Built-in (fallback)
    const [builtinTemplates, builtinStacks] = await Promise.all([
        fetchDir(TEMPLATES_PATH, 'template', 'Built-in'),
        fetchDir(STACKS_PATH, 'stack', 'Built-in')
    ]);

    const allTemplates = [...builtinStacks, ...builtinTemplates];

    // 2. External Registries (override built-in by name)
    const config = await getConfig();
    const registries = getRegistries(config);

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        const [regTemplates, regStacks] = await Promise.all([
            fetchDir(path.join(regPath, 'templates'), 'template', reg.name),
            fetchDir(path.join(regPath, 'stacks'), 'stack', reg.name)
        ]);

        // Registry versions override built-in templates with the same name
        const regItems = [...regStacks, ...regTemplates];
        for (const item of regItems) {
            const idx = allTemplates.findIndex(t => t.name === item.name && t.type === item.type);
            if (idx !== -1) {
                allTemplates[idx] = item;
            } else {
                allTemplates.push(item);
            }
        }
    }

    return allTemplates;
}

export async function getReadme(name: string, type: 'template' | 'stack', source?: string): Promise<string | null> {
  const subdir = type === 'stack' ? 'stacks' : 'templates';

  // If a specific source is given, use it directly
  if (source && source !== 'Built-in') {
    try {
      const filePath = path.join(REGISTRIES_DIR, source, subdir, name, 'README.md');
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // Otherwise: check registries first, then fall back to built-in
  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      try {
        const filePath = path.join(REGISTRIES_DIR, reg.name, subdir, name, 'README.md');
        return await fs.readFile(filePath, 'utf-8');
      } catch { /* not in this registry */ }
    }
  }

  // Built-in fallback
  try {
    const basePath = type === 'stack' ? STACKS_PATH : TEMPLATES_PATH;
    const filePath = path.join(basePath, name, 'README.md');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function getTemplateYaml(name: string, source?: string): Promise<string | null> {
  // If a specific source is given, use it directly
  if (source && source !== 'Built-in') {
    try {
      const filePath = path.join(REGISTRIES_DIR, source, 'templates', name, 'template.yml');
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // Otherwise: check registries first (freshest), then fall back to built-in
  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      try {
        const filePath = path.join(REGISTRIES_DIR, reg.name, 'templates', name, 'template.yml');
        return await fs.readFile(filePath, 'utf-8');
      } catch { /* not in this registry */ }
    }
  }

  // Built-in fallback
  try {
    const filePath = path.join(TEMPLATES_PATH, name, 'template.yml');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** NPM proxy host settings passed to POST /api/nginx/proxy-hosts */
export interface ProxyConfig {
  allow_websocket_upgrade?: boolean;
  block_exploits?: boolean;
  caching_enabled?: boolean;
  http2_support?: boolean;
  ssl_forced?: boolean;
  /** Custom nginx directives injected into the server block */
  advanced_config?: string;
}

export interface OidcClientConfig {
  client_id: string;
  client_name: string;
  authorization_policy?: string;
  redirect_uris: string[];
  scopes?: string[];
  /**
   * Name of a `secret`-type variable whose value should be used as the
   * client_secret. When set, the wizard auto-generates the secret once and
   * substitutes it into BOTH the service's env (e.g. SSO_CLIENT_SECRET) and
   * Authelia's clients[] entry, so env-var-driven OIDC integrations work
   * without any post-deploy copy-paste. Omit to let the oidc-clients
   * endpoint generate a fresh random secret each time (legacy behaviour).
   */
  clientSecretVar?: string;
  /**
   * Which credential transport the service's OIDC client library uses to
   * authenticate against Authelia's token endpoint. Authelia per-client
   * registration locks this to a single method — if the service sends
   * a different one, the token call fails with
   * `invalid_client / "client registration does not allow this method"`.
   *
   * Common values per service:
   *   - `client_secret_basic` — RFC 6749 default; what `openidconnect-rs`
   *     (Vaultwarden) sends. **Use this for new clients unless the
   *     upstream service explicitly documents `_post`.**
   *   - `client_secret_post` — what Immich's admin-API-driven
   *     configuration writes; also Audiobookshelf, Navidrome.
   *
   * Omit for the platform default (`client_secret_basic` from the
   * oidc-clients route).
   */
  token_endpoint_auth_method?: 'client_secret_basic' | 'client_secret_post';
}

export interface VariableMeta {
  type?: 'text' | 'password' | 'secret' | 'rsa-private' | 'bcrypt' | 'select' | 'device' | 'subdomain';
  description?: string;
  default?: string;
  /**
   * Concrete example value shown next to the input in the Configure
   * step (small grey hint text). Use for fields whose `description`
   * tells the user *what* but not what a *valid value looks like* —
   * URLs, e-mail addresses, fully-qualified domains, etc. Distinct
   * from `default` because we don't want to pre-fill every field
   * with example data the user then has to remember to change.
   */
  example?: string;
  options?: string[];
  devicePath?: string;
  /** For subdomain type: variable name referencing the target port, or a literal port number */
  proxyPort?: string;
  /** For subdomain type: service-specific NPM proxy host configuration */
  proxyConfig?: ProxyConfig;
  /**
   * For subdomain type: how this service is meant to be exposed.
   *   - `public`: reachable from the internet on 80/443, auto-request
   *     Let's Encrypt cert at install time and bind it to the proxy host.
   *   - `lan`: reachable only on the LAN, no TLS cert provisioned.
   * Each template declares a sensible default in variables.json; the
   * operator can override per-service in the wizard's configure step.
   * Missing/undefined treated the same as `lan` (the conservative
   * default — never auto-request a cert without explicit opt-in).
   * `internal` requests a cert (so Authelia forward-auth works) but
   * binds an NPM LAN-only access list so the host isn't reachable
   * from outside the LAN.
   */
  exposure?: 'public' | 'internal' | 'lan';
  /**
   * For subdomain type: when true, the service binds **only to the host
   * loopback** (e.g. Syncthing's `STGUIADDRESS=127.0.0.1:8384`).
   * NPM today runs `hostNetwork: true` and shares the host netns, so
   * `forward_host: 127.0.0.1` reaches the loopback-bound upstream
   * correctly. Default (false) routes through the node's LAN IP, which
   * is correct for any service binding 0.0.0.0 or the LAN address.
   * (#880; if #817 ever moves NPM off hostNetwork, the forward target
   * needs to switch to `host.containers.internal`.)
   */
  loopbackOnly?: boolean;
  /** OIDC client to register with Authelia when this service is deployed */
  oidcClient?: OidcClientConfig;
  /** For bcrypt type: name of another variable whose plaintext gets bcrypt-hashed */
  bcryptSource?: string;
  /**
   * Name of the template that first declared this variable. Set by the
   * wizard / installer when collecting variables across multiple templates,
   * used by the UI to group the configure step by service.
   */
  templateName?: string;
  /**
   * Friendly display label for the template that first declared this
   * variable, read from `metadata.annotations['servicebay.label']` in the
   * template.yml. Set alongside templateName by the wizard / installer.
   */
  templateLabel?: string;
}

export async function getTemplateVariables(name: string, source?: string): Promise<Record<string, VariableMeta> | null> {
  const tryRead = async (filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch { return null; }
  };

  if (source && source !== 'Built-in') {
    return tryRead(path.join(REGISTRIES_DIR, source, 'templates', name, 'variables.json'));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const result = await tryRead(path.join(REGISTRIES_DIR, reg.name, 'templates', name, 'variables.json'));
      if (result) return result;
    }
  }

  return tryRead(path.join(TEMPLATES_PATH, name, 'variables.json'));
}

export interface TemplateConfigFile {
  /** Filename without .mustache extension (e.g. "configuration.yml") */
  filename: string;
  /** Raw Mustache template content */
  content: string;
  /** Target path hint from template.yml volume mounts (set by caller) */
  targetPath?: string;
}

/** Find .mustache config files for a template (e.g. authelia/configuration.yml.mustache). */
export async function getTemplateConfigFiles(name: string, source?: string): Promise<TemplateConfigFile[]> {
  const scanDir = async (dirPath: string): Promise<TemplateConfigFile[]> => {
    try {
      const entries = await fs.readdir(dirPath);
      const mustacheFiles = entries.filter(f => f.endsWith('.mustache') && f !== 'template.yml.mustache');
      return Promise.all(mustacheFiles.map(async f => ({
        filename: f.replace(/\.mustache$/, ''),
        content: await fs.readFile(path.join(dirPath, f), 'utf-8'),
      })));
    } catch { return []; }
  };

  if (source && source !== 'Built-in') {
    return scanDir(path.join(REGISTRIES_DIR, source, 'templates', name));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const files = await scanDir(path.join(REGISTRIES_DIR, reg.name, 'templates', name));
      if (files.length > 0) return files;
    }
  }

  return scanDir(path.join(TEMPLATES_PATH, name));
}

/**
 * Read a template's post-deploy script if present. Convention: a single
 * `post-deploy.py` file in the template directory, executed by the agent
 * (python3 is guaranteed by FCoS install-python.service) after the unit
 * has started. The script gets the wizard's variables as env vars and
 * can either talk to the now-running container directly (e.g. POST to
 * the service's /init endpoint on its host port) or call ServiceBay's
 * own admin endpoints.
 *
 * It can emit:
 *   - regular stdout lines → relayed to the install log as-is
 *   - lines beginning with `__SB_CREDENTIAL__ ` followed by JSON →
 *     parsed by the wizard and added to the SAVE-THESE-NOW banner +
 *     Bitwarden CSV export
 *
 * Returns the script content (un-rendered, mustache placeholders intact)
 * or null if the template ships no post-deploy script.
 */
export async function getTemplatePostDeployScript(name: string, source?: string): Promise<string | null> {
  const tryRead = async (dir: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, 'post-deploy.py'), 'utf-8');
    } catch { return null; }
  };

  if (source && source !== 'Built-in') {
    return tryRead(path.join(REGISTRIES_DIR, source, 'templates', name));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const found = await tryRead(path.join(REGISTRIES_DIR, reg.name, 'templates', name));
      if (found !== null) return found;
    }
  }

  return tryRead(path.join(TEMPLATES_PATH, name));
}

/**
 * Read a template's `user-guide.md` for the user-facing portal (#242).
 * The file is optional — templates without one are skipped on /portal.
 * Same registry-fallback semantics as `getTemplatePostDeployScript`:
 * source pinned → only that registry; no source → walk every
 * configured registry then fall through to the bundled templates.
 *
 * Returns the raw markdown content (frontmatter intact) or null when
 * no guide is found.
 */
export async function getTemplateUserGuide(name: string, source?: string): Promise<string | null> {
  const tryRead = async (dir: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, 'user-guide.md'), 'utf-8');
    } catch { return null; }
  };

  if (source && source !== 'Built-in') {
    return tryRead(path.join(REGISTRIES_DIR, source, 'templates', name));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const found = await tryRead(path.join(REGISTRIES_DIR, reg.name, 'templates', name));
      if (found !== null) return found;
    }
  }

  return tryRead(path.join(TEMPLATES_PATH, name));
}

/**
 * Read a template's CHANGELOG.md. Same fall-through search as
 * `getTemplateUserGuide` (registry > built-in). Returns the raw
 * markdown text or null when missing. See #353.
 */
export async function getTemplateChangelog(name: string, source?: string): Promise<string | null> {
  const tryRead = async (dir: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf-8');
    } catch { return null; }
  };

  if (source && source !== 'Built-in') {
    return tryRead(path.join(REGISTRIES_DIR, source, 'templates', name));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const found = await tryRead(path.join(REGISTRIES_DIR, reg.name, 'templates', name));
      if (found !== null) return found;
    }
  }

  return tryRead(path.join(TEMPLATES_PATH, name));
}

/**
 * One template migration script — the discoverable unit of a `migrations/`
 * directory. Each file is named `v{N}-to-v{M}.py` (e.g. `v1-to-v2.py`)
 * and contains the script content with `{{MUSTACHE}}` placeholders.
 *
 * `fromVersion` and `toVersion` are parsed out of the filename; the
 * chain selector (`selectMigrationChain` in
 * `src/lib/stackInstall/migrations.ts`) walks them to figure out which
 * to run when an operator's installed version is older than the
 * template's current. See #352 phase 3.
 */
export interface TemplateMigrationScript {
  /** Original filename (e.g. `v1-to-v2.py`). */
  filename: string;
  /** Schema version this migration upgrades from. */
  fromVersion: number;
  /** Schema version this migration upgrades to. */
  toVersion: number;
  /** Un-rendered script body. Mustache placeholders intact. */
  content: string;
}

/**
 * Discover a template's `migrations/v{N}-to-v{M}.py` scripts. Same
 * registry-fallback semantics as `getTemplatePostDeployScript`: a
 * pinned `source` looks in that registry only; no source walks every
 * configured registry, then the built-in templates.
 *
 * Files whose names don't match the `v{N}-to-v{M}.py` pattern are
 * ignored — the consistency test
 * (`tests/backend/template_consistency.test.ts`) rejects illegal
 * filenames at build time so they never reach here.
 *
 * Returns an unsorted array — chain selection is the caller's job (see
 * `selectMigrationChain`). See #352 phase 3.
 */
export async function getTemplateMigrationScripts(
  name: string,
  source?: string,
): Promise<TemplateMigrationScript[]> {
  const filenameRe = /^v(\d+)-to-v(\d+)\.py$/;

  const scanDir = async (dir: string): Promise<TemplateMigrationScript[]> => {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(dir, 'migrations'));
    } catch {
      return [];
    }
    const out: TemplateMigrationScript[] = [];
    for (const entry of entries) {
      const m = filenameRe.exec(entry);
      if (!m) continue;
      const fromVersion = parseInt(m[1], 10);
      const toVersion = parseInt(m[2], 10);
      if (!Number.isFinite(fromVersion) || !Number.isFinite(toVersion)) continue;
      try {
        const content = await fs.readFile(path.join(dir, 'migrations', entry), 'utf-8');
        out.push({ filename: entry, fromVersion, toVersion, content });
      } catch {
        // Unreadable migration — skip rather than block the whole template;
        // the deploy will still run, just without that step. Logged at the
        // call site if missing-step ends up biting.
      }
    }
    return out;
  };

  if (source && source !== 'Built-in') {
    return scanDir(path.join(REGISTRIES_DIR, source, 'templates', name));
  }

  if (!source) {
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const found = await scanDir(path.join(REGISTRIES_DIR, reg.name, 'templates', name));
      if (found.length > 0) return found;
    }
  }

  return scanDir(path.join(TEMPLATES_PATH, name));
}

/**
 * Read + parse a stack's `stack.yml` manifest (#624). Returns the parsed
 * manifest, `null` when the stack has no `stack.yml` (README-only legacy),
 * or throws when the file exists but is structurally broken — the caller
 * (registry sync / consistency lint) should surface the error.
 *
 * Same registry-priority chain as `getTemplateYaml`: if `source` is
 * pinned, read only from there; otherwise registries take priority over
 * built-in. Throwing on parse failure (rather than returning `null`) is
 * intentional — a typo'd annotation should never silently degrade to
 * "no manifest, treat as README-only" because the wizard would then
 * present the stack with default tier/lifecycle instead of complaining.
 */
export async function getStackManifest(
  name: string,
  source?: string,
): Promise<StackManifest | null> {
  const tryRead = async (dir: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, 'stack.yml'), 'utf-8');
    } catch { return null; }
  };

  let yamlText: string | null = null;
  if (source && source !== 'Built-in') {
    yamlText = await tryRead(path.join(REGISTRIES_DIR, source, 'stacks', name));
  } else {
    if (!source) {
      const config = await getConfig();
      const registries = getRegistries(config);
      for (const reg of registries) {
        const found = await tryRead(path.join(REGISTRIES_DIR, reg.name, 'stacks', name));
        if (found !== null) { yamlText = found; break; }
      }
    }
    if (yamlText === null) yamlText = await tryRead(path.join(STACKS_PATH, name));
  }

  if (yamlText === null) return null;

  const result = parseStackManifest(yamlText);
  if (!result.ok) {
    throw new Error(
      `stack \`${name}\` has an invalid stack.yml:\n` +
      result.errors.map(e => `  - ${e}`).join('\n'),
    );
  }
  return result.manifest;
}
