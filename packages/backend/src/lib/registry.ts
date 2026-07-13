
import fs from 'fs/promises';
import path from 'path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'util';
import { getConfig, RegistryConfig } from './config';
import { DATA_DIR } from './dirs';
import { readManifestAnnotations } from './template/contract';
import { parseStackManifest, type StackManifest } from './template/stackContract';
import { logger } from './logger';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Registry git runs unattended in the server — never let git try to prompt for
// credentials. Without this, an unreachable or private registry repo makes
// `git clone/fetch` attempt an interactive username prompt, which fails with a
// cryptic "could not read Username for 'https://github.com'" (and can hang in
// environments that do have a TTY). GIT_TERMINAL_PROMPT=0 makes it fail fast
// and clearly so the registry is skipped and the others keep syncing.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const TEMPLATES_PATH = path.join(process.cwd(), 'templates');
const STACKS_PATH = path.join(process.cwd(), 'stacks');
const CONTAINER_CONFIG_DIR = '/app/.servicebay';
const REGISTRIES_DIR = path.join(
  process.env.CONTAINER_CONFIG_DIR || CONTAINER_CONFIG_DIR,
  'registries'
);

/**
 * Persistent, writable, **non-git** local template/stack source (#1919).
 *
 * Unlike `REGISTRIES_DIR` (under the ephemeral config dir) this lives on
 * the persisted data mount (`DATA_DIR` = `/app/data`, mapped to
 * `/mnt/data/servicebay` on the box), so a template dropped here survives
 * a container restart and a reinstall. It is the install target for the
 * `repo-to-template` skill (and file-drop by hand): no repo change and no
 * git registry needed.
 *
 * Layout mirrors the built-in tree exactly:
 *   local-templates/templates/<name>/{template.yml,variables.json,…}
 *   local-templates/stacks/<name>/stack.yml
 *
 * Precedence is the **highest** of all sources — local > registry >
 * built-in — so a local `vaultwarden` shadows both a registry copy and
 * the bundled one. A malformed local entry is skipped with a warning
 * (same as a bad registry entry) and never crashes catalog enumeration.
 */
const LOCAL_TEMPLATES_DIR = path.join(DATA_DIR, 'local-templates');
const LOCAL_TEMPLATES_PATH = path.join(LOCAL_TEMPLATES_DIR, 'templates');
const LOCAL_STACKS_PATH = path.join(LOCAL_TEMPLATES_DIR, 'stacks');

// Default registry: the ServiceBay repo itself (public, no auth needed)
const DEFAULT_REGISTRY: RegistryConfig = {
  name: 'servicebay',
  url: 'https://github.com/mdopp/servicebay.git',
};

/**
 * Optional registry-side manifest (#1050) describing where templates
 * and stacks live within the repo. Registries that don't ship a
 * `servicebay.json` keep using the legacy convention (`templates/<name>/`,
 * `stacks/<name>/`), so existing registries — `mdopp/servicebay`,
 * `mdopp/servicebay-templates` — keep working without change.
 *
 * The motivation is registries whose top-level layout reflects their
 * own subsystem boundaries rather than ServiceBay's expected
 * sparse-checkout shape — e.g. `mdopp/solbay` with
 * `servicebay-template/`, `hermes-skills/`, `voice-gatekeeper/`,
 * `database/` at the root. The manifest tells SB which of those
 * directories to scan as templates.
 *
 * Shape:
 *   {
 *     "templates": [{ "name": "oscar-household", "path": "servicebay-template" }],
 *     "stacks":    [{ "name": "household",       "path": "stacks/household"    }]
 *   }
 *
 * Paths are relative to the registry root; the legacy `templates/` and
 * `stacks/` directories continue to be scanned as a fallback when the
 * manifest is missing.
 */
interface RegistryManifestEntry {
  name: string;
  path: string;
}

interface RegistryManifest {
  templates?: RegistryManifestEntry[];
  stacks?: RegistryManifestEntry[];
}

/**
 * Per-registry manifest cache. Cleared on every `syncRegistries` call
 * so a freshly-pulled manifest is picked up without a server restart.
 * `null` means "checked the disk, no manifest present" — distinct from
 * "not yet checked" (key absent).
 */
const manifestCache = new Map<string, RegistryManifest | null>();

/**
 * Test-only escape hatch to drop the manifest cache without invoking
 * `syncRegistries`. The cache is module-scoped, so unit tests that
 * reuse a registry name across cases would otherwise pollute each
 * other. Production code paths reset via `syncRegistries`'s own
 * `manifestCache.clear()`.
 */
export function _resetRegistryManifestCacheForTests(): void {
  manifestCache.clear();
}

async function readRegistryManifest(regName: string): Promise<RegistryManifest | null> {
  if (manifestCache.has(regName)) return manifestCache.get(regName) ?? null;
  // `regName` is config-supplied — constrain it to a single safe segment so a
  // crafted registry name can't traverse out of REGISTRIES_DIR (js/path-injection).
  const p = safeJoin(REGISTRIES_DIR, regName, 'servicebay.json');
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as RegistryManifest;
    manifestCache.set(regName, parsed);
    return parsed;
  } catch {
    manifestCache.set(regName, null);
    return null;
  }
}

/**
 * Resolve the on-disk directory for a template or stack in a given
 * registry, consulting the manifest first and falling back to the
 * legacy `<type>s/<name>/` convention. Returns the absolute path even
 * when the directory doesn't exist — caller's existing fs.access /
 * fs.readFile failure paths handle "not found" the same way they did
 * before the manifest existed.
 */
async function resolveRegistryItemPath(
  regName: string,
  type: 'template' | 'stack',
  itemName: string,
): Promise<string> {
  const manifest = await readRegistryManifest(regName);
  const entries = type === 'template' ? manifest?.templates : manifest?.stacks;
  // The registry root is `REGISTRIES_DIR/<safe regName>`. `regName` is
  // config-supplied, so it goes through the single-segment barrier; the
  // resulting root is what every join below must stay under
  // (js/path-injection; #1919 barrier).
  const regRoot = safeJoin(REGISTRIES_DIR, regName);
  if (entries) {
    const entry = entries.find(e => e.name === itemName);
    // A manifest `entry.path` may legitimately carry internal `/` separators
    // (e.g. `servicebay-template`, `stacks/household`), so it can't go through
    // the single-segment barrier. Instead resolve it against the registry root
    // and confirm the result stays inside — a `../` or absolute path is rejected
    // to the nonexistent sentinel so the read fails closed.
    if (entry) return resolveWithinRoot(regRoot, entry.path);
  }
  // Legacy fallback — also the path for manifest-less registries. `itemName`
  // is request-supplied → single-segment barrier.
  const subdir = type === 'template' ? 'templates' : 'stacks';
  return safeJoin(regRoot, subdir, itemName);
}

/**
 * A path segment guaranteed never to exist. Returned by `safeSegment` /
 * `safeJoin` when a request-supplied component fails the traversal barrier,
 * so every caller's `fs.readFile` / `fs.readdir` / `fs.access` fails closed
 * to "not found" instead of reading outside its intended root.
 */
const UNSAFE_SENTINEL = '\0nonexistent';

/**
 * Traversal barrier for a **single** request-supplied path component
 * (a template/stack/registry name, or a manifest-declared segment).
 *
 * Collapses `seg` to a lone path component with `path.basename` (the
 * CodeQL-recognised path-injection sanitiser) and rejects it if that
 * changed the value or produced a traversal / empty / NUL-bearing
 * segment — so only a plain, self-contained name is ever joined onto a
 * root. On rejection returns `UNSAFE_SENTINEL` (a guaranteed-nonexistent
 * name) so the join fails closed rather than escaping the root.
 *
 * Shared by `localItemPath`, `readRegistryManifest`,
 * `resolveRegistryItemPath` and the built-in-template joins — every place
 * a caller-supplied name reaches the filesystem (CodeQL js/path-injection,
 * following the #1919 barrier).
 */
function safeSegment(seg: string): string {
  const base = path.basename(seg);
  if (
    !base ||
    base !== seg ||
    base === '.' ||
    base === '..' ||
    base.includes('\0')
  ) {
    return UNSAFE_SENTINEL;
  }
  return base;
}

/**
 * `path.join(root, ...segments)` with each segment forced through the
 * `safeSegment` traversal barrier first. A single unsafe segment collapses
 * the whole join to a guaranteed-nonexistent path under `root`, so the
 * result can never escape it. Manifest-declared `entry.path` values (which
 * legitimately carry internal `/` separators) are NOT routed through here —
 * they are constrained separately (see `resolveRegistryItemPath`).
 */
function safeJoin(root: string, ...segments: string[]): string {
  const safe = segments.map(safeSegment);
  return path.join(root, ...safe);
}

/**
 * Join a **multi-segment** relative path (which may legitimately contain
 * internal `/` separators — e.g. a manifest's `stacks/household`) onto
 * `root`, then confirm the resolved result stays inside `root`. A `../`,
 * absolute path, or any value that escapes `root` collapses to the
 * guaranteed-nonexistent sentinel under `root`, so the read fails closed
 * rather than reaching outside the registry (CodeQL js/path-injection).
 */
function resolveWithinRoot(root: string, rel: string): string {
  if (rel.includes('\0')) return path.join(root, UNSAFE_SENTINEL);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, rel);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return path.join(root, UNSAFE_SENTINEL);
  }
  // Re-derive the in-root path from the sanitised relative remainder so the
  // value CodeQL sees flowing to `fs` is built from the barrier output, not
  // the raw taint.
  const inner = path.relative(resolvedRoot, resolved);
  return inner ? path.join(root, inner) : root;
}

/**
 * The on-disk directory for a `Local`-source template or stack (#1919).
 * Mirrors the built-in layout under the persisted data mount. Returns
 * the path even when the dir doesn't exist — callers' fs failure paths
 * handle "not found" the same way they do for built-in/registry items.
 *
 * `name` is request-supplied, so it is constrained to a single safe path
 * segment via `safeSegment` (no separators, no `.`/`..`, no NUL). An
 * unsafe `name` resolves to a guaranteed-nonexistent sentinel so every
 * caller's fs path fails closed to "not found" rather than reading outside
 * the local source (path-injection guard; CodeQL js/path-injection).
 */
function localItemPath(type: 'template' | 'stack', name: string): string {
  const root = type === 'stack' ? LOCAL_STACKS_PATH : LOCAL_TEMPLATES_PATH;
  return safeJoin(root, name);
}

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
      logger.warn('registry', `failed to load stack manifest for ${name}:`, e);
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
      logger.error('registry', `Error fetching ${type}s from ${source}:`, e);
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
    await execFileAsync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, dest], { env: GIT_ENV });
    await execFileAsync('git', ['sparse-checkout', 'set', ...dirs], { cwd: dest });
}

/**
 * Widen an already-sparse clone to include extra paths declared by the
 * registry's `servicebay.json`. Called after the initial sparse-checkout
 * exposes the manifest itself — once we read which custom paths it
 * names, this pulls them in without re-cloning. No-op if the manifest
 * declares no entries that fall outside the default patterns.
 */
async function widenSparseForManifest(regPath: string, manifest: RegistryManifest): Promise<void> {
    const extra = new Set<string>();
    for (const e of manifest.templates ?? []) extra.add(e.path);
    for (const e of manifest.stacks ?? []) extra.add(e.path);
    if (extra.size === 0) return;
    // Keep the defaults so legacy `templates/` and `stacks/` co-existence
    // (a repo that ships some of each shape) still works.
    const patterns = ['templates', 'stacks', 'servicebay.json', ...extra];
    try {
        await execFileAsync('git', ['sparse-checkout', 'set', ...patterns], { cwd: regPath });
    } catch (e) {
        // Failure here doesn't strand the registry — the manifest still
        // points at paths that just won't be present on disk; downstream
        // `fs.readFile` returns the same "not found" the operator would
        // see for a stale manifest.
        logger.warn('registry', `widenSparseForManifest failed for ${regPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
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

/** Clone a registry into `regPath` (sparse first, full-clone fallback). Shared
 *  by the initial clone and the #1796 self-heal re-clone. */
async function cloneRegistry(reg: RegistryConfig, regPath: string): Promise<void> {
    logger.info('registry', `Cloning registry ${reg.name}...`);
    try {
        // Default sparse patterns include `servicebay.json` so a manifest-using
        // registry exposes it on the first clone; `widenSparseForManifest` then
        // pulls any custom paths declared inside.
        await cloneSparse(reg.url, regPath, ['templates', 'stacks', 'servicebay.json']);
    } catch {
        // Fallback to full clone if sparse checkout not supported
        await execFileAsync('git', ['clone', '--depth', '1', reg.url, regPath], { env: GIT_ENV });
    }
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
        logger.info('registry', 'Registry sync skipped: git not available (built-in templates still served).');
        return;
    }

    try {
        await fs.mkdir(REGISTRIES_DIR, { recursive: true });
    } catch {}

    // Clear the manifest cache so any servicebay.json updates pulled
    // this round are picked up. Pre-existing readers will re-read once.
    manifestCache.clear();

    for (const reg of registries) {
        const regPath = path.join(REGISTRIES_DIR, reg.name);
        // Isolate each registry: a single bad URL (a 404'd repo, an
        // unreachable mirror) used to abort the entire loop, so the
        // registries listed *after* it never got synced — which is why
        // a stale `ServiceBay Templates` entry could silently strand
        // the canonical `mdopp/servicebay` clone. Per-registry try/catch
        // keeps subsequent registries syncing.
        try {
            const hasGit = await fs
                .access(path.join(regPath, '.git'))
                .then(() => true)
                .catch(() => false);
            if (!hasGit) {
                await cloneRegistry(reg, regPath);
            } else {
                // Exists — fetch latest and reset (shallow clones can't reliably git pull)
                logger.info('registry', `Updating registry ${reg.name}...`);
                const branch = reg.branch || 'main';
                try {
                    // #1836: `git fetch --depth 1 origin <branch>` with a bare
                    // branch name only moves FETCH_HEAD — it does NOT update the
                    // remote-tracking ref `refs/remotes/origin/<branch>` on a
                    // shallow/sparse clone, which was pinned at clone time. So
                    // `git reset --hard origin/<branch>` reset to the *stale*
                    // clone-time SHA, leaving the checkout behind remote HEAD
                    // (box stranded at d556247 while HEAD was 1fa1717). Reset to
                    // FETCH_HEAD — exactly what we just fetched — so a single
                    // refresh always reaches remote HEAD.
                    await execAsync(`git fetch --depth 1 origin ${branch}`, { cwd: regPath, env: GIT_ENV });
                    await execAsync('git reset --hard FETCH_HEAD', { cwd: regPath, env: GIT_ENV });
                } catch (updateErr) {
                    // #1796: a `git reset --hard` that can't unlink the working
                    // tree — e.g. root-owned files written into the bind mount by
                    // another container (SB itself runs non-root) — would leave
                    // the registry permanently stale, silently serving old
                    // templates/skills. Self-heal: rename the broken tree aside
                    // (that needs only write on the SB-owned PARENT dir, NOT
                    // ownership of the tree) and re-clone fresh as the SB uid.
                    // If even the parent is root-owned the rename throws and the
                    // per-registry catch below leaves it stale (a privileged
                    // chown of REGISTRIES_DIR is then the only recourse) — never
                    // worse than today's behaviour.
                    const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
                    logger.warn('registry', `Registry ${reg.name} update failed (${msg}); re-cloning fresh (#1796 self-heal).`);
                    await fs.rename(regPath, `${regPath}.broken-${Date.now()}`);
                    await cloneRegistry(reg, regPath);
                }
            }
            // Manifest pass: if the registry ships `servicebay.json`, pull
            // any custom paths it declares (e.g. `servicebay-template/`,
            // `hermes-skills/`) into the sparse working tree so the
            // resolver helpers find them. No-op for legacy registries.
            const manifest = await readRegistryManifest(reg.name);
            if (manifest) {
                await widenSparseForManifest(regPath, manifest);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('registry', `Registry ${reg.name} (${reg.url}) sync failed — skipping (other registries continue): ${msg}`);
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
        const manifest = await readRegistryManifest(reg.name);

        // Templates: manifest-declared paths if a manifest exists, else
        // legacy `templates/` scan. Stacks: same. A registry that ships
        // a manifest declaring `templates[]` but no `stacks[]` falls back
        // to scanning `stacks/` for the stacks half — that's the most
        // useful mixed-shape behaviour (most registries have a clear
        // "templates live here, stacks are conventional" split).
        const regTemplates: Template[] = manifest?.templates
            ? await fetchManifestEntries(regPath, manifest.templates, 'template', reg.name)
            : await fetchDir(path.join(regPath, 'templates'), 'template', reg.name);
        const regStacks: Template[] = manifest?.stacks
            ? await fetchManifestEntries(regPath, manifest.stacks, 'stack', reg.name)
            : await fetchDir(path.join(regPath, 'stacks'), 'stack', reg.name);

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

    // 3. Local persistent source (#1919) — overrides BOTH built-in and
    // registry by name, so a user-generated/file-dropped template wins.
    // `fetchDir` returns [] for a missing dir and skips a malformed entry
    // with a warning, so an empty or partly-broken local-templates dir
    // never crashes enumeration.
    const [localStacks, localTemplates] = await Promise.all([
        fetchDir(LOCAL_STACKS_PATH, 'stack', 'Local'),
        fetchDir(LOCAL_TEMPLATES_PATH, 'template', 'Local'),
    ]);
    for (const item of [...localStacks, ...localTemplates]) {
        const idx = allTemplates.findIndex(t => t.name === item.name && t.type === item.type);
        if (idx !== -1) {
            allTemplates[idx] = item;
        } else {
            allTemplates.push(item);
        }
    }

    return allTemplates;
}

/**
 * Manifest-aware sibling to `fetchDir`. Where `fetchDir` reads every
 * subdirectory of a fixed parent (`templates/` or `stacks/`),
 * `fetchManifestEntries` walks the explicit `{name, path}` list from
 * `servicebay.json`. Missing dirs are silently dropped — the operator
 * gets the same "template not visible" symptom they'd get from a
 * legacy registry with a missing folder, and the consistency lint
 * catches it at build time.
 */
async function fetchManifestEntries(
  regPath: string,
  entries: RegistryManifestEntry[],
  type: 'template' | 'stack',
  source: string,
): Promise<Template[]> {
  const out: Template[] = [];
  for (const entry of entries) {
    const itemDir = path.join(regPath, entry.path);
    try {
      await fs.access(itemDir);
    } catch {
      // Manifest names a path the working tree doesn't have — most
      // likely a stale manifest or a sparse-checkout that didn't widen.
      // Skip rather than crash the whole registry's enumeration.
      logger.warn('registry', `manifest entry ${source}/${entry.name} → ${entry.path} not present on disk`);
      continue;
    }
    const { tier, dependencies } = await readTemplateMeta(itemDir, type, entry.name, source);
    out.push({
      name: entry.name,
      path: itemDir,
      url: '',
      type,
      source,
      tier,
      dependencies,
    });
  }
  return out;
}

export async function getReadme(name: string, type: 'template' | 'stack', source?: string): Promise<string | null> {
  // Local pinned source (#1919) — read straight from the data mount.
  if (source === 'Local') {
    try {
      return await fs.readFile(path.join(localItemPath(type, name), 'README.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  // If a specific source is given, use it directly
  if (source && source !== 'Built-in') {
    try {
      const itemDir = await resolveRegistryItemPath(source, type, name);
      return await fs.readFile(path.join(itemDir, 'README.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  // Otherwise: local persistent source first (#1919), then registries,
  // then fall back to built-in.
  if (!source) {
    try {
      return await fs.readFile(path.join(localItemPath(type, name), 'README.md'), 'utf-8');
    } catch { /* not in the local source */ }
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      try {
        const itemDir = await resolveRegistryItemPath(reg.name, type, name);
        return await fs.readFile(path.join(itemDir, 'README.md'), 'utf-8');
      } catch { /* not in this registry */ }
    }
  }

  // Built-in fallback — `name` is request-supplied → single-segment barrier.
  try {
    const basePath = type === 'stack' ? STACKS_PATH : TEMPLATES_PATH;
    const filePath = safeJoin(basePath, name, 'README.md');
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function getTemplateYaml(name: string, source?: string): Promise<string | null> {
  // Local pinned source (#1919) — read straight from the data mount.
  if (source === 'Local') {
    try {
      return await fs.readFile(path.join(localItemPath('template', name), 'template.yml'), 'utf-8');
    } catch {
      return null;
    }
  }

  // If a specific source is given, use it directly
  if (source && source !== 'Built-in') {
    try {
      const itemDir = await resolveRegistryItemPath(source, 'template', name);
      return await fs.readFile(path.join(itemDir, 'template.yml'), 'utf-8');
    } catch {
      return null;
    }
  }

  // Otherwise: local persistent source first (#1919, freshest/user-owned),
  // then registries, then fall back to built-in.
  if (!source) {
    try {
      return await fs.readFile(path.join(localItemPath('template', name), 'template.yml'), 'utf-8');
    } catch { /* not in the local source */ }
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      try {
        const itemDir = await resolveRegistryItemPath(reg.name, 'template', name);
        return await fs.readFile(path.join(itemDir, 'template.yml'), 'utf-8');
      } catch { /* not in this registry */ }
    }
  }

  // Built-in fallback — `name` is request-supplied → single-segment barrier.
  try {
    const filePath = safeJoin(TEMPLATES_PATH, name, 'template.yml');
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
  /**
   * #999 — Set to true for upstreams that reject requests whose Host
   * header doesn't match their bind address (uvicorn's TrustedHost
   * middleware is the canonical example — hermes dashboard). The
   * proxy-hosts route's post-create patcher inlines NPM's proxy.conf
   * inside the `location /` block AND appends a `proxy_set_header
   * Host <forwardHost>:<forwardPort>;` so the upstream sees its own
   * bind address. Default (false / unset) keeps NPM's `Host $host`,
   * which is what most upstreams want.
   */
  strictUpstreamHost?: boolean;
  /**
   * #1683 — Set to true for upstreams that enforce an anti-DNS-rebind
   * Host check and only accept a *local* Host (ollama: `127.0.0.1:11434`,
   * `localhost`, or its `OLLAMA_HOST`). Like `strictUpstreamHost` the
   * patcher inlines NPM's proxy.conf and sends a SINGLE Host header
   * (replacing proxy.conf's `Host $host` — never appending a second
   * Host line, which makes nginx forward two Hosts and the upstream
   * 400s), but the value is forced to `127.0.0.1:<forwardPort>` so the
   * upstream sees a loopback Host regardless of the node's LAN IP.
   */
  localUpstreamHost?: boolean;
  /**
   * #2210 — Path prefixes that SKIP forward-auth on an otherwise Authelia-
   * gated (`forwardAuth: true`) host. Each emits an `auth_request off`
   * location that still proxies to the upstream, letting unauthenticated
   * fetchers reach specific public paths — e.g. `/.well-known/assetlinks.json`
   * (Google's Digital-Asset-Links check that drops a TWA's URL bar),
   * `/.well-known/` (ACME, apple-app-site-association, security.txt), or
   * `/static/` (PWA icons/manifest for reproducible app builds). Only
   * meaningful together with the forward-auth sentinel `advanced_config`.
   */
  authSkipPaths?: string[];
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
   * #1002 — For `type: secret`, opt out of the install-time random
   * auto-generation. Use for operator-supplied externally-issued
   * secrets (Telegram/Discord bot tokens, HA long-lived tokens) where
   * a generated random string would be rejected by the third-party
   * service on every reconnect, creating tight error loops in the
   * consumer's log. The consumer post-deploy must handle an empty
   * value gracefully (skip writing the .env entry, don't enable the
   * gateway, etc.).
   */
  noAutoGenerate?: boolean;
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

  if (source === 'Local') {
    return tryRead(path.join(localItemPath('template', name), 'variables.json'));
  }

  if (source && source !== 'Built-in') {
    const itemDir = await resolveRegistryItemPath(source, 'template', name);
    return tryRead(path.join(itemDir, 'variables.json'));
  }

  if (!source) {
    const local = await tryRead(path.join(localItemPath('template', name), 'variables.json'));
    if (local) return local;
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const itemDir = await resolveRegistryItemPath(reg.name, 'template', name);
      const result = await tryRead(path.join(itemDir, 'variables.json'));
      if (result) return result;
    }
  }

  // `name` is request-supplied → single-segment barrier.
  return tryRead(safeJoin(TEMPLATES_PATH, name, 'variables.json'));
}

export interface TemplateConfigFile {
  /** Filename without .mustache extension (e.g. "configuration.yml").
   *  For asset files this is the path *relative to the template dir*
   *  (e.g. "skills/audit-query/SKILL.md") so the receiver has a
   *  meaningful name for diagnostics. */
  filename: string;
  /** Raw Mustache template content (when `renderContent` is true) or
   *  verbatim file bytes (when false). */
  content: string;
  /** Target path on the agent host. Always Mustache-rendered against
   *  the deploy variables, so `{{DATA_DIR}}` etc. resolve. */
  targetPath?: string;
  /** When false, `content` is shipped verbatim — Mustache rendering is
   *  skipped. Used for asset files (Hermes SKILL.md and similar) whose
   *  body may legitimately contain `{{...}}` literals that aren't
   *  placeholders. Default: true (current `.mustache` config-file
   *  behaviour). #1156. */
  renderContent?: boolean;
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

  if (source === 'Local') {
    return scanDir(localItemPath('template', name));
  }

  if (source && source !== 'Built-in') {
    return scanDir(await resolveRegistryItemPath(source, 'template', name));
  }

  if (!source) {
    const localFiles = await scanDir(localItemPath('template', name));
    if (localFiles.length > 0) return localFiles;
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const files = await scanDir(await resolveRegistryItemPath(reg.name, 'template', name));
      if (files.length > 0) return files;
    }
  }

  // `name` is request-supplied → single-segment barrier.
  return scanDir(safeJoin(TEMPLATES_PATH, name));
}

/**
 * Walk `<template-dir>/skills/` recursively and return one
 * `TemplateConfigFile` per file, with `targetPath` pre-set to
 * `{{DATA_DIR}}/<template-name>/skills/<relative-path>` and
 * `renderContent: false` so Mustache leaves SKILL.md bodies alone
 * (they often contain `{{...}}` literals as documentation that
 * mustache would otherwise corrupt).
 *
 * The install runner concatenates the result with the regular
 * `.mustache` config files; the existing `extraFiles` transport
 * (`packages/backend/src/lib/services/serviceLifecycle.ts:677`)
 * writes each one to the agent host via `agent.sendCommand('write_file', …)`.
 * This is the delivery path that #1025's README claim ("placed there
 * by ServiceBay's registry sync") was missing. #1156.
 *
 * Returns `[]` when the template ships no `skills/` directory —
 * which is every template today except OSCAR's `oscar-household`
 * (after migration to `mdopp/solbay`).
 *
 * Same registry-fallback semantics as `getTemplateConfigFiles`.
 * Symlinks are ignored to keep the convention to "files in the
 * template's own tree only" — operators introducing symlinks should
 * use an explicit asset annotation if/when one lands.
 */
async function walkSkillsDir(skillsDir: string, templateName: string): Promise<TemplateConfigFile[]> {
  try {
    const st = await fs.stat(skillsDir);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const out: TemplateConfigFile[] = [];
  const stack: string[] = ['.'];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(path.join(skillsDir, rel), { withFileTypes: true });
    } catch {
      // Unreadable subdir — skip rather than break the whole walk.
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isSymbolicLink()) continue;
      const childRel = rel === '.' ? ent.name : path.join(rel, ent.name);
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        const content = await fs.readFile(path.join(skillsDir, childRel), 'utf-8');
        out.push({
          filename: path.join('skills', childRel),
          content,
          targetPath: `{{DATA_DIR}}/${templateName}/skills/${childRel}`,
          renderContent: false,
        });
      }
    }
  }
  return out;
}

export async function getTemplateAssetFiles(
  name: string,
  source?: string,
): Promise<TemplateConfigFile[]> {
  const walk = (templateDir: string) =>
    walkSkillsDir(path.join(templateDir, 'skills'), name);

  if (source === 'Local') {
    return walk(localItemPath('template', name));
  }

  if (source && source !== 'Built-in') {
    return walk(await resolveRegistryItemPath(source, 'template', name));
  }

  if (!source) {
    const localFiles = await walk(localItemPath('template', name));
    if (localFiles.length > 0) return localFiles;
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const files = await walk(await resolveRegistryItemPath(reg.name, 'template', name));
      if (files.length > 0) return files;
    }
  }

  // `name` is request-supplied → single-segment barrier.
  return walk(safeJoin(TEMPLATES_PATH, name));
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
  return readTemplateFile(name, 'post-deploy.py', source);
}

/**
 * Read one file out of a template's directory, walking the same
 * source-resolution chain every template lookup uses:
 *
 *   source === 'Local'        → only the persisted local-templates dir
 *   source (a registry name)  → only that registry
 *   no source                 → local → every configured registry →
 *                               bundled built-in templates
 *
 * Returns the raw file content, or `null` when the file isn't present in
 * the resolved location(s). This is the single primitive behind
 * `getTemplateUserGuide`, `getTemplateChangelog`,
 * `getTemplatePostDeployScript` and the portal's `template.yml` /
 * `variables.json` readers — so a registry-installed service (e.g.
 * `solaris` from the `solbay` registry) is found exactly like a
 * built-in one rather than silently dropping out of `/portal`.
 */
export async function readTemplateFile(
  name: string,
  filename: string,
  source?: string,
): Promise<string | null> {
  const tryRead = async (dir: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, filename), 'utf-8');
    } catch { return null; }
  };

  if (source === 'Local') {
    return tryRead(localItemPath('template', name));
  }

  if (source && source !== 'Built-in') {
    return tryRead(await resolveRegistryItemPath(source, 'template', name));
  }

  if (!source) {
    const local = await tryRead(localItemPath('template', name));
    if (local !== null) return local;
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const found = await tryRead(await resolveRegistryItemPath(reg.name, 'template', name));
      if (found !== null) return found;
    }
  }

  // `name` is request-supplied → single-segment barrier.
  return tryRead(safeJoin(TEMPLATES_PATH, name));
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
  return readTemplateFile(name, 'user-guide.md', source);
}

/**
 * Read a template's CHANGELOG.md. Same fall-through search as
 * `getTemplateUserGuide` (registry > built-in). Returns the raw
 * markdown text or null when missing. See #353.
 */
export async function getTemplateChangelog(name: string, source?: string): Promise<string | null> {
  return readTemplateFile(name, 'CHANGELOG.md', source);
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

  if (source === 'Local') {
    return scanDir(localItemPath('template', name));
  }

  if (source && source !== 'Built-in') {
    return scanDir(await resolveRegistryItemPath(source, 'template', name));
  }

  if (!source) {
    const local = await scanDir(localItemPath('template', name));
    if (local.length > 0) return local;
    const config = await getConfig();
    const registries = getRegistries(config);
    for (const reg of registries) {
      const found = await scanDir(await resolveRegistryItemPath(reg.name, 'template', name));
      if (found.length > 0) return found;
    }
  }

  // `name` is request-supplied → single-segment barrier.
  return scanDir(safeJoin(TEMPLATES_PATH, name));
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
  if (source === 'Local') {
    yamlText = await tryRead(localItemPath('stack', name));
  } else if (source && source !== 'Built-in') {
    yamlText = await tryRead(await resolveRegistryItemPath(source, 'stack', name));
  } else {
    if (!source) {
      // Local persistent source first (#1919), then registries.
      yamlText = await tryRead(localItemPath('stack', name));
      if (yamlText === null) {
        const config = await getConfig();
        const registries = getRegistries(config);
        for (const reg of registries) {
          const found = await tryRead(await resolveRegistryItemPath(reg.name, 'stack', name));
          if (found !== null) { yamlText = found; break; }
        }
      }
    }
    // `name` is request-supplied → single-segment barrier.
    if (yamlText === null) yamlText = await tryRead(safeJoin(STACKS_PATH, name));
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
