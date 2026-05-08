/**
 * Template ↔ codebase consistency suite.
 *
 * Catches the class of bugs we hit during the file-share / home-assistant /
 * auth / media merges: a template gets renamed or merged, but `isSelected('X')`
 * / SERVICE_DEPS / DISPLAY_NAMES / getServiceFiles still references the old
 * name. None of those fail at compile time, only at runtime when the wizard
 * runs and the deploy step skips the seed/credential surfacing.
 *
 * Four categories, each gated as one test so a single failure points to a
 * specific rule:
 *
 *  1. Every template name referenced in src/ resolves to a real templates/X/ dir.
 *  2. Every {{VAR}} in a template's YAML/mustache is declared somewhere
 *     (own variables.json, settings.json globals, or another template's
 *     variables.json — cross-template references are normal).
 *  3. Every template renders to a YAML doc that js-yaml accepts and that
 *     contains a Pod kind with hostNetwork + at least one container.
 *  4. Every subdomain variable's `proxyPort` is either numeric or names
 *     a variable that exists somewhere in the catalog.
 *
 * No agent / podman / network needed. Pure file-system + parsing.
 */

import fs from 'fs';
import path from 'path';
import Mustache from 'mustache';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');
const SRC_DIR = path.join(REPO_ROOT, 'src');

interface TemplateInfo {
  name: string;
  yamlPath: string;
  yamlContent: string;
  variablesPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  variables: Record<string, any>;
  /** Parsed `*.mustache` config files (filename → raw content). */
  configs: Record<string, string>;
}

function listTemplates(): TemplateInfo[] {
  return fs.readdirSync(TEMPLATES_DIR)
    .filter(name => {
      const full = path.join(TEMPLATES_DIR, name);
      return fs.statSync(full).isDirectory();
    })
    .map(name => {
      const dir = path.join(TEMPLATES_DIR, name);
      const yamlPath = path.join(dir, 'template.yml');
      const variablesPath = path.join(dir, 'variables.json');
      const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
      const variables = JSON.parse(fs.readFileSync(variablesPath, 'utf-8'));
      const configs: Record<string, string> = {};
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.mustache') && f !== 'template.yml.mustache') {
          configs[f] = fs.readFileSync(path.join(dir, f), 'utf-8');
        }
      }
      return { name, yamlPath, yamlContent, variablesPath, variables, configs };
    });
}

function readSettingsGlobals(): string[] {
  const settingsPath = path.join(TEMPLATES_DIR, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  return Object.keys(settings.variables ?? {});
}

/** Recursively yield .ts/.tsx files under `root` (excluding tests). */
function* walkSourceFiles(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(full);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

/** Collect every Mustache reference (`{{VAR}}`, `{{{VAR}}}`, `{{#VAR}}`,
 *  `{{^VAR}}`, `{{/VAR}}`) from a chunk of text. Comments (`{{!...}}`) are
 *  stripped first. Returns the set of bare variable names. */
function extractMustacheVars(text: string): Set<string> {
  const stripped = text.replace(/\{\{!.*?\}\}/g, '');
  const out = new Set<string>();
  const re = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.add(m[1]);
  }
  return out;
}

const templates = listTemplates();
const templateNames = new Set(templates.map(t => t.name));
const globalVars = new Set(readSettingsGlobals());

// Union of every variable declared by every template — for cross-template
// references like file-share's filebrowser proxyConfig pointing at AUTHELIA_PORT.
const catalogVars = new Set<string>(globalVars);
for (const t of templates) for (const k of Object.keys(t.variables)) catalogVars.add(k);

// ─── 1. Template ↔ source-name drift ────────────────────────────────────────
describe('Template ↔ source-name consistency', () => {
  // Names that look like template strings but aren't actually template-dir
  // references — e.g. service identifiers passed as API payloads, OIDC
  // client_ids, etc. Keeping the allow-list explicit forces a deliberate
  // decision when something new shows up here.
  const NON_TEMPLATE_NAMES = new Set([
    // service= payload values for /api/system/media/init — refers to the
    // *which seeder to run*, not a template-dir name.
    'audiobookshelf',
    'navidrome',
    // OIDC client_id values inside Authelia config
    'servicebay',
    'immich',
    'home-assistant',
    'homeassistant',
    'audiobookshelf-oidc',
  ]);

  // Patterns to scan for in src/ — each captures a template-name string literal.
  const PATTERNS: { name: string; re: RegExp }[] = [
    { name: "isSelected(...)",          re: /isSelected\(\s*['"]([^'"]+)['"]\s*\)/g },
    { name: "getServiceFiles(node, X)", re: /getServiceFiles\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g },
    { name: "restartService(node, X)",  re: /restartService\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g },
  ];

  it('every template-name string in src/ resolves to an existing template', () => {
    const offenders: { file: string; pattern: string; name: string }[] = [];
    for (const file of walkSourceFiles(SRC_DIR)) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const { name: pat, re } of PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const ref = m[1];
          if (templateNames.has(ref)) continue;
          if (NON_TEMPLATE_NAMES.has(ref)) continue;
          offenders.push({
            file: path.relative(REPO_ROOT, file),
            pattern: pat,
            name: ref,
          });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map(o => `  ${o.file} — ${o.pattern} → "${o.name}"`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} reference(s) to template names that don't exist in templates/:\n${msg}\n\n` +
        `Either add the template, fix the typo, or add the string to NON_TEMPLATE_NAMES (with a comment).`,
      );
    }
  });

  it('SERVICE_DEPS keys + values reference real templates only', () => {
    // Pull the SERVICE_DEPS literal out of OnboardingWizard.tsx without TS-importing
    // a client component (which would drag in React) — string-extract from source.
    const wizardPath = path.join(SRC_DIR, 'components', 'OnboardingWizard.tsx');
    const content = fs.readFileSync(wizardPath, 'utf-8');
    // Match the SERVICE_DEPS object literal block.
    const block = content.match(/SERVICE_DEPS:\s*Record<string,\s*ServiceDeps>\s*=\s*\{([\s\S]*?)\n\s*\};/);
    expect(block, 'SERVICE_DEPS block not found in OnboardingWizard.tsx').toBeTruthy();

    const body = block![1];
    // Keys: anything before `:`, optionally quoted.
    const keyRe = /^\s*['"]?([\w-]+)['"]?\s*:\s*\{/gm;
    const depRe = /(?:requires|recommendedWith)\s*:\s*\[([^\]]*)\]/g;

    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body)) !== null) {
      if (!templateNames.has(m[1])) offenders.push(`SERVICE_DEPS key "${m[1]}"`);
    }
    while ((m = depRe.exec(body)) !== null) {
      const list = m[1];
      const items = [...list.matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
      for (const item of items) {
        if (!templateNames.has(item)) offenders.push(`SERVICE_DEPS dep target "${item}"`);
      }
    }
    expect(offenders, `Stale SERVICE_DEPS entries:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('groupVariables.DISPLAY_NAMES keys reference real templates only', () => {
    const groupPath = path.join(SRC_DIR, 'lib', 'stackInstall', 'groupVariables.ts');
    const content = fs.readFileSync(groupPath, 'utf-8');
    const block = content.match(/DISPLAY_NAMES:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/);
    expect(block, 'DISPLAY_NAMES block not found').toBeTruthy();

    const body = block![1];
    const keyRe = /^\s*['"]([\w-]+)['"]\s*:/gm;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body)) !== null) {
      if (!templateNames.has(m[1])) offenders.push(m[1]);
    }
    expect(offenders, `DISPLAY_NAMES keys without a matching template:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

// ─── 2. Mustache vars are declared somewhere ────────────────────────────────
describe('Template variables are declared', () => {
  for (const t of templates) {
    it(`${t.name}: every {{VAR}} is declared`, () => {
      const refs = extractMustacheVars(t.yamlContent);
      for (const cfg of Object.values(t.configs)) {
        for (const v of extractMustacheVars(cfg)) refs.add(v);
      }
      const undeclared: string[] = [];
      for (const ref of refs) {
        if (catalogVars.has(ref)) continue;
        undeclared.push(ref);
      }
      expect(
        undeclared,
        `${t.name}: ${undeclared.length} undeclared variable(s):\n  ${undeclared.join(', ')}\n\n` +
        `Declare in ${t.name}/variables.json, in templates/settings.json globals, or fix the typo.`,
      ).toEqual([]);
    });
  }
});

// ─── 3. Each template renders to a valid Pod ────────────────────────────────
describe('Templates render to valid Pod manifests', () => {
  /** Build a Mustache view that supplies a value for every variable referenced
   *  by any template. Defaults from variables.json win; otherwise stub strings.
   *  For section blocks (`{{#X}}...`) Mustache reads the value's truthiness;
   *  defaults like '' would skip the block, which matches reality. */
  const view: Record<string, string> = {};
  for (const v of catalogVars) {
    // Stub fallbacks first; per-template defaults (if present) overwrite.
    if (/PORT$/.test(v)) view[v] = '8080';
    else if (/PASSWORD|SECRET|HASH$/.test(v)) view[v] = 'stub-secret';
    else if (/PATH$/.test(v)) view[v] = '/stub';
    else view[v] = `stub-${v.toLowerCase()}`;
  }
  // Apply real defaults from each template's variables.json.
  for (const t of templates) {
    for (const [name, meta] of Object.entries(t.variables)) {
      if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
        view[name] = meta.default;
      }
    }
  }
  // Apply settings.json globals.
  const settings = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, 'settings.json'), 'utf-8'));
  for (const [name, meta] of Object.entries(settings.variables ?? {})) {
    if (meta && typeof meta === 'object' && 'default' in (meta as Record<string, unknown>)) {
      const def = (meta as { default?: unknown }).default;
      if (typeof def === 'string') view[name] = def;
    }
  }
  // ZWAVE_DEVICE acts as a section gate — when truthy, the home-assistant
  // template emits the Z-Wave container. Setting it to a fake path exercises
  // *more* of the YAML in the test, which is what we want.
  view.ZWAVE_DEVICE = '/dev/serial/by-id/stub-zwave';
  // RSA private key is multi-line and pre-indented in the real wizard. Just
  // give it a plausible single-line stub for parse-time validation.
  view.AUTHELIA_OIDC_RSA_PRIVATE_KEY = '          -----BEGIN STUB-----\n          stub\n          -----END STUB-----';

  for (const t of templates) {
    it(`${t.name}: template.yml renders to a parseable Pod with ≥1 container`, () => {
      let rendered = '';
      try {
        rendered = Mustache.render(t.yamlContent, view);
      } catch (e) {
        throw new Error(`${t.name}: Mustache failed to render: ${e instanceof Error ? e.message : String(e)}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try {
        parsed = yaml.load(rendered);
      } catch (e) {
        throw new Error(`${t.name}: rendered YAML is not parseable:\n${e instanceof Error ? e.message : String(e)}`);
      }

      expect(parsed?.kind, `${t.name}: rendered doc must be kind=Pod`).toBe('Pod');
      expect(parsed?.metadata?.name, `${t.name}: pod must have metadata.name`).toBeTruthy();
      // Reachability rule: either hostNetwork=true OR every published port
      // declares a hostPort. Some stacks (nginx-web / vaultwarden / immich)
      // use explicit hostPort mapping instead of hostNetwork because they
      // need the cap-bound 80/443 split, so the test accepts both modes.
      const hostNetwork = parsed?.spec?.hostNetwork === true;
      expect(Array.isArray(parsed?.spec?.containers), `${t.name}: containers must be an array`).toBe(true);
      expect(parsed.spec.containers.length, `${t.name}: at least one container required`).toBeGreaterThan(0);
      for (const c of parsed.spec.containers) {
        expect(c.name, `${t.name}: every container needs a name`).toBeTruthy();
        expect(c.image, `${t.name}: every container needs an image`).toBeTruthy();
        // Containers that declare ports must either be in a hostNetwork pod
        // or attach a hostPort to each entry — otherwise the port is
        // unreachable and the deploy is silently broken.
        if (Array.isArray(c.ports) && c.ports.length > 0 && !hostNetwork) {
          for (const p of c.ports) {
            expect(
              p.hostPort,
              `${t.name}/${c.name}: container port ${p.containerPort} has no hostPort and pod isn't hostNetwork — unreachable`,
            ).toBeTruthy();
          }
        }
      }
    });
  }
});

// ─── 4. Subdomain proxyPort references resolve ──────────────────────────────
describe('Subdomain proxyPort references', () => {
  for (const t of templates) {
    it(`${t.name}: every subdomain proxyPort resolves`, () => {
      const offenders: string[] = [];
      for (const [varName, meta] of Object.entries(t.variables) as [
        string,
        { type?: string; proxyPort?: string },
      ][]) {
        if (meta?.type !== 'subdomain') continue;
        const pp = meta.proxyPort;
        if (!pp) {
          offenders.push(`${varName}: no proxyPort declared`);
          continue;
        }
        // Numeric port → fine.
        if (/^\d+$/.test(pp)) continue;
        // Named variable → must exist either locally or globally.
        if (!catalogVars.has(pp)) {
          offenders.push(`${varName}: proxyPort "${pp}" not declared anywhere`);
        }
      }
      expect(
        offenders,
        `${t.name}: dangling proxyPort reference(s):\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});
