/**
 * Stack manifest parser (#624 / Phase 2A of the install rearchitecture).
 *
 * `stack.yml` is the structured sibling of `template.yml`: it groups one
 * or more templates into a single lifecycle unit (install / wipe / health
 * aggregate). Today the `stacks/` directory is README-only; this module
 * is the contract that future `stack.yml` manifests must satisfy.
 *
 * Schema:
 *
 *   apiVersion: v1
 *   kind: Stack
 *   metadata:
 *     name: basic
 *     annotations:
 *       servicebay.label: "Core services (NPM + LLDAP/Authelia + AdGuard)"
 *       servicebay.tier: "core"             # core | feature
 *       servicebay.lifecycle: "atomic-wipe" # atomic-wipe | wipeable
 *       servicebay.depends-on-stacks: "basic"
 *   spec:
 *     templates: [nginx, auth, adguard]
 *
 * Why a separate file from `template/contract.ts`: stack.yml has none of
 * template.yml's Mustache placeholders, so we can use a real YAML parser
 * (`js-yaml`) instead of regex-based annotation reads. The template
 * parser stays regex-based because it has to operate on un-rendered
 * templates with `{{VAR}}` strings.
 *
 * No fs/Node deps — pure function, safe to import from React components.
 */

import yaml from 'js-yaml';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

/**
 * Lifecycle tier. Drives the feature-install gate (#PH5C): if any
 * `tier: core` stack is unhealthy, the wizard refuses to install any
 * `tier: feature` stack.
 */
export type StackTier = 'core' | 'feature';
const KNOWN_TIERS: ReadonlySet<StackTier> = new Set(['core', 'feature']);

/**
 * Wipe semantics. `atomic-wipe` is reserved for the core stack — wiping
 * it is FACTORY RESET; the UI gates it behind explicit confirmation.
 * `wipeable` is the default — operators can one-click wipe a feature
 * stack at any time.
 */
export type StackLifecycle = 'atomic-wipe' | 'wipeable';
const KNOWN_LIFECYCLES: ReadonlySet<StackLifecycle> = new Set(['atomic-wipe', 'wipeable']);

/**
 * Self-heal mode for a template's secrets. Declared in stack.yml under
 * `metadata.selfHeal` as `{ <templateName>: <mode> }`.
 *
 * - `env_override`: The template regenerates credentials from environment
 *   variables on startup — no manual intervention needed.
 * - `api_rotation`: The install runner rotates API keys automatically.
 * - `recreate_on_key_wipe`: Data is wiped and recreated from scratch when
 *   the encryption key changes — safe but lossy.
 * - `none`: The template cannot self-heal. Wiping secrets while preserving
 *   this template's data group is unsafe and blocked by resetValidation.
 */
export type SelfHealMode = 'env_override' | 'api_rotation' | 'recreate_on_key_wipe' | 'none';
const KNOWN_SELF_HEAL_MODES: ReadonlySet<SelfHealMode> = new Set([
  'env_override', 'api_rotation', 'recreate_on_key_wipe', 'none',
]);

/** Parsed stack metadata. Stable shape — both runtime + tests rely on it. */
export interface StackManifest {
  /** `metadata.name`. Required, must match the directory name (caller checks). */
  name: string;
  /** `metadata.annotations['servicebay.label']` — friendly UI label. Required. */
  label: string;
  /** `metadata.annotations['servicebay.tier']`. Defaults to `feature`. */
  tier: StackTier;
  /** `metadata.annotations['servicebay.lifecycle']`. Defaults to `wipeable`. */
  lifecycle: StackLifecycle;
  /**
   * `metadata.annotations['servicebay.depends-on-stacks']` — comma-separated
   * list of stack names that must be healthy before this stack installs.
   * Whole-stack dependency, not per-template; the per-template dep graph
   * (servicebay.dependencies on template.yml) still drives the deploy
   * order *within* a stack. Empty when missing.
   */
  dependsOnStacks: string[];
  /** `spec.templates`. Required, non-empty list of template names. */
  templates: string[];
  /**
   * `metadata.selfHeal` — per-template self-heal mode declarations.
   * Optional. When present, maps template names to their recovery
   * strategy after a secrets wipe. Used by resetValidation.ts to
   * block unsafe preserve/wipe combinations (#849 / ARCH-17).
   */
  selfHeal?: Record<string, SelfHealMode>;
}

export type StackParseResult =
  | { ok: true; manifest: StackManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

interface RawAnnotations {
  [key: string]: unknown;
}

interface RawMetadata {
  name?: unknown;
  annotations?: unknown;
}

interface RawSpec {
  templates?: unknown;
}

interface RawDoc {
  apiVersion?: unknown;
  kind?: unknown;
  metadata?: unknown;
  spec?: unknown;
}

interface RawSelfHeal {
  [key: string]: unknown;
}

/**
 * Parse a stack.yml manifest. Pure function — caller passes the YAML text
 * and gets back either a complete manifest or a list of human-readable
 * errors. Does NOT verify that referenced template names exist on disk;
 * that's the `stack_consistency` lint's job (runs over the file system).
 */
export function parseStackManifest(yamlText: string): StackParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: RawDoc;
  try {
    const loaded = yaml.load(yamlText);
    if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return {
        ok: false,
        errors: ['stack.yml must be a YAML mapping (top-level object with apiVersion/kind/metadata/spec keys).'],
        warnings,
      };
    }
    doc = loaded as RawDoc;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`stack.yml is not valid YAML: ${msg}`], warnings };
  }

  if (doc.apiVersion !== 'v1') {
    errors.push(`Field \`apiVersion\` must be "v1"; got ${JSON.stringify(doc.apiVersion ?? null)}.`);
  }
  if (doc.kind !== 'Stack') {
    errors.push(`Field \`kind\` must be "Stack"; got ${JSON.stringify(doc.kind ?? null)}.`);
  }

  const meta: RawMetadata =
    typeof doc.metadata === 'object' && doc.metadata !== null && !Array.isArray(doc.metadata)
      ? (doc.metadata as RawMetadata)
      : {};
  const spec: RawSpec =
    typeof doc.spec === 'object' && doc.spec !== null && !Array.isArray(doc.spec)
      ? (doc.spec as RawSpec)
      : {};

  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!name) {
    errors.push('Missing required field `metadata.name`. Set it to the stack directory name (e.g. `metadata.name: basic`).');
  }

  const annotations: RawAnnotations =
    typeof meta.annotations === 'object' && meta.annotations !== null && !Array.isArray(meta.annotations)
      ? (meta.annotations as RawAnnotations)
      : {};

  const label = readAnnotationString(annotations, 'servicebay.label');
  if (!label) {
    errors.push(
      'Missing required annotation `servicebay.label`. Add it under `metadata.annotations` ' +
      'with a friendly display name (e.g. `servicebay.label: "Immich (Photos)"`).',
    );
  }

  let tier: StackTier = 'feature';
  const tierRaw = readAnnotationString(annotations, 'servicebay.tier');
  if (tierRaw !== undefined) {
    if (KNOWN_TIERS.has(tierRaw as StackTier)) {
      tier = tierRaw as StackTier;
    } else {
      errors.push(
        `Annotation \`servicebay.tier\` must be one of ${[...KNOWN_TIERS].map(v => `"${v}"`).join(', ')}; ` +
        `got "${tierRaw}".`,
      );
    }
  }

  let lifecycle: StackLifecycle = 'wipeable';
  const lifecycleRaw = readAnnotationString(annotations, 'servicebay.lifecycle');
  if (lifecycleRaw !== undefined) {
    if (KNOWN_LIFECYCLES.has(lifecycleRaw as StackLifecycle)) {
      lifecycle = lifecycleRaw as StackLifecycle;
    } else {
      errors.push(
        `Annotation \`servicebay.lifecycle\` must be one of ${[...KNOWN_LIFECYCLES].map(v => `"${v}"`).join(', ')}; ` +
        `got "${lifecycleRaw}".`,
      );
    }
  }

  // `atomic-wipe` only makes sense for core. Surface as a warning rather
  // than an error so future combinations stay possible without a parser
  // bump, but flag it loudly.
  if (lifecycle === 'atomic-wipe' && tier !== 'core') {
    warnings.push(
      `Lifecycle \`atomic-wipe\` is intended for \`tier: core\` stacks only. ` +
      `Stack \`${name || '?'}\` has tier "${tier}" — operators won't be able to wipe it from the UI.`,
    );
  }

  const dependsRaw = readAnnotationString(annotations, 'servicebay.depends-on-stacks');
  const dependsOnStacks = dependsRaw
    ? dependsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const templatesRaw = spec.templates;
  const templates: string[] = [];
  if (!Array.isArray(templatesRaw)) {
    errors.push('Missing required field `spec.templates`. Set it to a non-empty list of template names (e.g. `[nginx, auth]`).');
  } else {
    for (let i = 0; i < templatesRaw.length; i++) {
      const entry = templatesRaw[i];
      if (typeof entry !== 'string' || !entry.trim()) {
        errors.push(`Field \`spec.templates[${i}]\` must be a non-empty string template name; got ${JSON.stringify(entry)}.`);
        continue;
      }
      templates.push(entry.trim());
    }
    if (templates.length === 0 && templatesRaw.length === 0) {
      errors.push('Field `spec.templates` is empty. A stack must own at least one template.');
    }

    // Duplicates in `spec.templates` make the topo-install order ambiguous
    // and break the wipe step (the second entry's data dir is already
    // gone by the time we get to it).
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const t of templates) {
      if (seen.has(t)) dupes.add(t);
      seen.add(t);
    }
    if (dupes.size > 0) {
      errors.push(`Field \`spec.templates\` contains duplicates: ${[...dupes].join(', ')}.`);
    }
  }

  // A stack that depends on itself is a structural error — surface here
  // instead of letting the consistency lint catch it as a cycle, so the
  // error message points at the offending stack directly.
  if (name && dependsOnStacks.includes(name)) {
    errors.push(`Annotation \`servicebay.depends-on-stacks\` lists \`${name}\` itself — a stack cannot depend on itself.`);
  }

  // Parse selfHeal block (#849 / ARCH-17)
  let selfHeal: Record<string, SelfHealMode> | undefined;
  const rawSelfHeal = (meta as Record<string, unknown>).selfHeal;
  if (rawSelfHeal !== undefined) {
    if (typeof rawSelfHeal !== 'object' || rawSelfHeal === null || Array.isArray(rawSelfHeal)) {
      errors.push('Field `metadata.selfHeal` must be a mapping of template names to heal modes (e.g. `{ nginx: api_rotation }`).');
    } else {
      selfHeal = {};
      const heal = rawSelfHeal as RawSelfHeal;
      for (const [tpl, mode] of Object.entries(heal)) {
        if (typeof mode !== 'string' || !KNOWN_SELF_HEAL_MODES.has(mode as SelfHealMode)) {
          errors.push(
            `Field \`metadata.selfHeal.${tpl}\` must be one of ` +
            `${[...KNOWN_SELF_HEAL_MODES].map(v => `"${v}"`).join(', ')}; ` +
            `got ${JSON.stringify(mode)}.`,
          );
          continue;
        }
        if (!templates.includes(tpl)) {
          warnings.push(
            `selfHeal key "${tpl}" is not in spec.templates — ` +
            `this declaration has no effect unless the template is added to the stack.`,
          );
        }
        selfHeal[tpl] = mode as SelfHealMode;
      }
      if (Object.keys(selfHeal).length === 0) selfHeal = undefined;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    manifest: {
      name,
      label: label!,
      tier,
      lifecycle,
      dependsOnStacks,
      templates,
      selfHeal,
    },
    warnings,
  };
}

/**
 * Compact helper for callers that only care whether a manifest exists.
 * Returns `null` when parsing fails. Use the full `parseStackManifest`
 * when you need the error list (registry sync, consistency tests).
 */
export function tryParseStackManifest(yamlText: string): StackManifest | null {
  const r = parseStackManifest(yamlText);
  return r.ok ? r.manifest : null;
}

function readAnnotationString(annotations: RawAnnotations, key: string): string | undefined {
  const val = annotations[key];
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Load all stack.yml manifests from the stacks/ directory and return
 * the parsed manifests (with selfHeal data). Used by resetValidation.ts
 * for dynamic combo validation.
 *
 * @param stacksDir - Override for tests; defaults to `<repoRoot>/stacks`.
 */
export async function loadStackManifestsWithSelfHeal(
  stacksDir?: string,
): Promise<StackManifest[]> {
  const dir = stacksDir ?? path.resolve(__dirname, '../../../../stacks');
  const entries = await readdir(dir, { withFileTypes: true });
  const manifests: StackManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ymlPath = path.join(dir, entry.name, 'stack.yml');
    try {
      const text = await readFile(ymlPath, 'utf-8');
      const result = parseStackManifest(text);
      if (result.ok) {
        manifests.push(result.manifest);
      }
    } catch {
      // Skip directories without a stack.yml.
    }
  }

  return manifests;
}
