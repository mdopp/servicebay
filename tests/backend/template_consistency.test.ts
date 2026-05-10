/**
 * Template ↔ codebase consistency suite.
 *
 * Catches the class of bugs we hit during the file-share / home-assistant /
 * auth / media merges: a template gets renamed or merged, but `isSelected('X')`
 * / SERVICE_DEPS / servicebay.label / getServiceFiles still references the old
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

  it('every template.yml declares a servicebay.label annotation', async () => {
    // Friendly template labels live in the template itself
    // (metadata.annotations['servicebay.label']), so a new template
    // doesn't need to touch core code to get a non-default UI label.
    // The wizard / installer modal extracts the label at variable-
    // collection time via parseTemplateLabel(); the test exercises the
    // same parser to guarantee consistency.
    const { parseTemplateLabel } = await import('../../src/lib/templateLabel');
    const offenders: string[] = [];
    for (const t of templates) {
      const label = parseTemplateLabel(t.yamlContent);
      if (!label) {
        offenders.push(`${t.name}: parseTemplateLabel returned no label`);
      }
    }
    expect(
      offenders,
      `Templates missing the servicebay.label annotation:\n  ${offenders.join('\n  ')}\n\n` +
      `Add \`servicebay.label: "<friendly name>"\` under metadata.annotations in template.yml.`,
    ).toEqual([]);
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

      // Multi-document YAML support — some templates ship a Pod plus a
      // PersistentVolumeClaim alongside (e.g. file-share's syncthing-config
      // is podman-managed via a PVC declared in the same file).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let docs: any[];
      try {
        docs = yaml.loadAll(rendered);
      } catch (e) {
        throw new Error(`${t.name}: rendered YAML is not parseable:\n${e instanceof Error ? e.message : String(e)}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = docs.find((d: any) => d?.kind === 'Pod');

      expect(parsed?.kind, `${t.name}: rendered doc must contain a kind=Pod entry`).toBe('Pod');
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

// ─── 8. stacks/*/README.md `- [x] X` items resolve to real templates ──────
describe('Stack README service lists', () => {
  // The wizard parses `stacks/<name>/README.md` for `- [x] <name> — <desc>`
  // lines via the same regex defined in OnboardingWizard.tsx. Every name on
  // the left must resolve to a real templates/<name>/ directory — otherwise
  // the user picks a checkbox the wizard then can't fetch a template for.
  // This is the bug that surfaced after the auth+media merges: full-stack
  // README still listed lldap / authelia / audiobookshelf / navidrome /
  // filebrowser / home-assistant-stack while the templates dir had renamed
  // them all to merged stacks.
  const STACKS_DIR = path.join(REPO_ROOT, 'stacks');
  const stacks = fs.existsSync(STACKS_DIR)
    ? fs.readdirSync(STACKS_DIR).filter(n => fs.statSync(path.join(STACKS_DIR, n)).isDirectory())
    : [];

  // Same regex shape as OnboardingWizard.tsx so we test what the wizard sees.
  const itemRe = /^-\s*\[([ xX])\]\s*([\w\d_-]+)\s*(?:[—–\-:]\s*(.+))?$/;

  for (const stackName of stacks) {
    it(`stacks/${stackName}/README.md service items resolve to real templates`, () => {
      const readmePath = path.join(STACKS_DIR, stackName, 'README.md');
      if (!fs.existsSync(readmePath)) {
        // Stack with no README is fine — wizard just shows an empty list.
        return;
      }
      const lines = fs.readFileSync(readmePath, 'utf-8').split('\n');
      const offenders: { line: number; name: string }[] = [];
      lines.forEach((line, i) => {
        const m = line.match(itemRe);
        if (!m) return;
        const name = m[2].trim();
        if (!templateNames.has(name)) {
          offenders.push({ line: i + 1, name });
        }
      });
      if (offenders.length > 0) {
        const msg = offenders.map(o => `  README:${o.line} — "${o.name}" has no matching templates/${o.name}/ directory`).join('\n');
        throw new Error(
          `stacks/${stackName}/README.md lists ${offenders.length} service(s) that don't exist as templates:\n${msg}\n\n` +
          `Either rename the README entry to match a real template, drop the line, or add the template.`,
        );
      }
    });
  }
});

// ─── 7. Templates that ship mustache configs declare a config-mount target ─
describe('Mustache configs have a resolvable target mount', () => {
  // Every *.mustache file in a template directory gets rendered + written to
  // a host bind path during deploy. The wizard's resolver picks the target
  // path from `servicebay.config-mount: <mountPath>` annotation, falling back
  // to a `/config` / `/conf`-like heuristic. The fallback is fragile in
  // multi-mount pods: the *first* matching mount wins, so a template with
  // two `/config`-suffix mounts can route the file to the wrong volume.
  // Make the annotation a hard requirement when mustache files are present.
  for (const t of templates) {
    if (Object.keys(t.configs).length === 0) continue;
    it(`${t.name}: has a servicebay.config-mount annotation that resolves to a real mountPath`, () => {
      // Render the YAML with a stub view so we can parse it.
      const safeYaml = t.yamlContent.replace(/\{\{[^}]+\}\}/g, '0');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let docs: any[];
      try {
        docs = yaml.loadAll(safeYaml);
      } catch (e) {
        throw new Error(`${t.name}: cannot parse template.yml: ${e instanceof Error ? e.message : String(e)}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pod = docs.find((d: any) => d?.kind === 'Pod');
      const annot: string | undefined = pod?.metadata?.annotations?.['servicebay.config-mount'];
      expect(
        annot,
        `${t.name} ships ${Object.keys(t.configs).join(', ')} but has no \`servicebay.config-mount: <mountPath>\` annotation. ` +
        `Without it the resolver falls back to a /config-suffix heuristic, which silently picks the wrong mount in multi-volume pods. ` +
        `Add the annotation pointing at the container's config mountPath.`,
      ).toBeTruthy();

      // The annotation value must match a real mountPath somewhere in the pod.
      const mountPaths = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const c of (pod?.spec?.containers ?? []) as any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const vm of (c.volumeMounts ?? []) as any[]) {
          if (typeof vm?.mountPath === 'string') mountPaths.add(vm.mountPath);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ic of (pod?.spec?.initContainers ?? []) as any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const vm of (ic.volumeMounts ?? []) as any[]) {
          if (typeof vm?.mountPath === 'string') mountPaths.add(vm.mountPath);
        }
      }
      expect(
        mountPaths.has(annot!),
        `${t.name}: servicebay.config-mount = "${annot}" but no container mounts that path. Resolver has nothing to write into. Mounts seen: ${[...mountPaths].join(', ')}`,
      ).toBe(true);
    });
  }
});

// ─── 6. STACK_MIGRATIONS map shape ─────────────────────────────────────────
describe('ServiceManager.STACK_MIGRATIONS map shape', () => {
  // Migrations: every key must be a current template (the new name);
  // every value must NOT be a current template (must be an obsolete name).
  // Catches typos + accidental "migrate from a template that still exists",
  // which would soft-delete the active unit on every deploy.
  it('keys reference real templates, predecessors are no-longer-existing names', () => {
    const sm = fs.readFileSync(path.join(SRC_DIR, 'lib', 'services', 'ServiceManager.ts'), 'utf-8');
    const block = sm.match(/STACK_MIGRATIONS:\s*Record<string,\s*string\[\]>\s*=\s*\{([\s\S]*?)\n\s*\};/);
    expect(block, 'STACK_MIGRATIONS block not found in ServiceManager.ts').toBeTruthy();

    const body = block![1];
    const entryRe = /^\s*['"]([\w-]+)['"]\s*:\s*\[([^\]]*)\]/gm;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = entryRe.exec(body)) !== null) {
      const key = m[1];
      const values = [...m[2].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
      if (!templateNames.has(key)) {
        offenders.push(`STACK_MIGRATIONS key "${key}" — no matching template (typo, or stale entry?)`);
      }
      for (const v of values) {
        if (templateNames.has(v)) {
          offenders.push(`STACK_MIGRATIONS["${key}"] = ["${v}", …] — "${v}" is still a current template; migrating from it would soft-delete the live deploy on every install`);
        }
      }
    }
    expect(offenders, `STACK_MIGRATIONS shape problems:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

// ─── 5. OIDC client_id is single-source-of-truth in templates ──────────────
describe('OIDC client_id single source of truth', () => {
  // Every OIDC client_id we serve to Authelia (and surface to the user as
  // "paste this") is declared in a template's variables.json under
  // oidcClient.client_id. This rule blocks src/ from hardcoding the same
  // string elsewhere — the kind of dual source-of-truth duplication that
  // sent us chasing a "wrong service name" ghost during the auth+media merge.
  const declaredClientIds = new Set<string>();
  for (const t of templates) {
    for (const meta of Object.values(t.variables) as { oidcClient?: { client_id?: string } }[]) {
      if (typeof meta?.oidcClient?.client_id === 'string') {
        declaredClientIds.add(meta.oidcClient.client_id);
      }
    }
  }

  // Files exempt from the rule because they consume the value at the API
  // boundary (Authelia request bodies, OIDC callback handlers) — those
  // legitimately reference `client_id` as a parameter name, not duplicate
  // the literal value of one.
  const EXEMPT_FILES = new Set<string>([
    'src/app/api/auth/oidc/route.ts',                // OIDC initiator — clientId comes from config
    'src/app/api/auth/oidc/callback/route.ts',       // OIDC callback handler
    'src/app/api/system/authelia/oidc-clients/route.ts', // forwards client.client_id from input
    'src/lib/registry.ts',                           // type definition
  ]);

  it('no src/ file hardcodes a client_id / username literal that mirrors an OIDC declaration', () => {
    // Only flag the *narrow* pattern that would actually create dual sources
    // of truth: an object literal assigning a known client_id string to one
    // of these key names. Substrings used for unrelated purposes (e.g.
    // `service: 'audiobookshelf'` in /api/system/media/init/route.ts is a
    // seeder discriminator, not an OIDC duplication) don't match this regex
    // and stay quiet.
    const KEYS = ['client_id', 'clientId', 'username'];
    const offenders: { file: string; line: number; key: string; clientId: string }[] = [];
    for (const file of walkSourceFiles(SRC_DIR)) {
      const rel = path.relative(REPO_ROOT, file);
      if (EXEMPT_FILES.has(rel)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip line comments and JSDoc / block-comment continuation lines —
        // those mention identifiers prosaically (e.g. "Previously this
        // section hardcoded `username: 'audiobookshelf'`") rather than
        // duplicating them in code.
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        for (const key of KEYS) {
          const re = new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`);
          const m = line.match(re);
          if (!m) continue;
          if (declaredClientIds.has(m[1])) {
            offenders.push({ file: rel, line: i + 1, key, clientId: m[1] });
          }
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map(o => `  ${o.file}:${o.line} — ${o.key}: '${o.clientId}' duplicates an OIDC client_id from variables.json`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} hardcoded OIDC client_id assignment(s) in src/:\n${msg}\n\n` +
        `Read the value from variables[].meta.oidcClient instead of duplicating the string. ` +
        `If the file genuinely needs it as a literal, add the path to EXEMPT_FILES with a comment.`,
      );
    }
  });
});

// ─── 10. No new per-template branches in stackInstall/ ────────────────────
describe('stackInstall has no unauthorized per-template branches', () => {
  // Per-template glue (credential surfacing, admin seeding, etc.) lives in
  // each template's own post-deploy.py. The engine only keeps branches that
  // genuinely need core knowledge — currently nginx-web's bootstrapNpmAdmin,
  // because it returns a tri-state result that drives the wizard's
  // credential-prompt UI (a script can't cleanly express that).
  //
  // Every other `isSelected('X')` is dead code or a regression in waiting.
  // This test fails if a new template name shows up in stackInstall/* —
  // forcing the author to either (a) extend post-deploy.py or (b) document
  // why their case can't live in a script and add it to ALLOWED below.
  const STACKINSTALL_DIR = path.join(SRC_DIR, 'lib', 'stackInstall');

  /** Map of file → set of template names allowed to appear in
   *  `isSelected(...)` calls. Anything else is a violation. */
  const ALLOWED: Record<string, Set<string>> = {
    'postInstall.ts': new Set([
      // bootstrapNpmAdmin returns a tri-state result that drives the
      // wizard's NPM-credentials-prompt UI when the auto-bootstrap
      // fails. A post-deploy.py script can't cleanly express that, so
      // the NPM bootstrap stays in the engine.
      'nginx-web',
    ]),
    'credentialsManifest.ts': new Set(),
    'groupVariables.ts': new Set(),
  };

  for (const [file, allowed] of Object.entries(ALLOWED)) {
    it(`${file}: no isSelected/get('X') calls outside the allow-list`, () => {
      const fullPath = path.join(STACKINSTALL_DIR, file);
      if (!fs.existsSync(fullPath)) return;
      const content = fs.readFileSync(fullPath, 'utf-8');
      const re = /isSelected\(\s*['"]([\w-]+)['"]\s*\)/g;
      const offenders: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const name = m[1];
        if (!allowed.has(name)) offenders.push(name);
      }
      if (offenders.length > 0) {
        const unique = [...new Set(offenders)].sort();
        throw new Error(
          `${file} references template name(s) not in the allow-list: ${unique.join(', ')}\n\n` +
          `Per-template glue should live in templates/<name>/post-deploy.py, not in core. ` +
          `Either migrate the logic (preferred) or, if the case genuinely needs core access, ` +
          `add the name to ALLOWED in this test with a one-line comment explaining why.`,
        );
      }
    });
  }
});

// ─── 11. Template tier classification ─────────────────────────────────────
describe('Template tier classification', () => {
  // Per the design conversation in #249, every install ships with the
  // `infrastructure`-tier templates (DNS, reverse proxy, SSO) auto-
  // included and locked-checked. Currently three templates fill these
  // roles. The wizard reads the tier from each template.yml's
  // `metadata.annotations['servicebay.tier']`.
  //
  // Enforce that exactly the expected three templates declare
  // `infrastructure`. Drift (a 4th infra template appearing without
  // a design decision, or one of the three losing the annotation)
  // is a build failure.
  const EXPECTED_INFRA = new Set(['adguard', 'auth', 'nginx-web']); // post-rename: 'nginx'

  it('exactly the platform templates are tier=infrastructure', async () => {
    const { parseTemplateTier } = await import('../../src/lib/templateTier');
    const infraNames = templates
      .filter(t => parseTemplateTier(t.yamlContent) === 'infrastructure')
      .map(t => t.name)
      .sort();
    const expected = [...EXPECTED_INFRA].sort();
    expect(infraNames).toEqual(expected);
  });
});

// ─── 9. post-deploy.py scripts parse as valid Python ───────────────────────
describe('Template post-deploy.py syntax', () => {
  // The wizard executes templates/<name>/post-deploy.py on the agent host
  // after a successful deploy. A syntax error there would silently break
  // the seed / credential-banner step at install time. Catch them at
  // PR-time via `python3 -m py_compile`. Skipped if python3 isn't on the
  // CI runner (rare but possible in some docker-only setups).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execSync } = require('child_process') as typeof import('child_process');
  let pythonAvailable = true;
  try {
    execSync('python3 --version', { stdio: 'ignore' });
  } catch {
    pythonAvailable = false;
  }

  for (const t of templates) {
    const script = path.join(TEMPLATES_DIR, t.name, 'post-deploy.py');
    if (!fs.existsSync(script)) continue;
    const testFn = pythonAvailable ? it : it.skip;
    testFn(`${t.name}/post-deploy.py is syntactically valid Python`, () => {
      try {
        execSync(`python3 -m py_compile ${JSON.stringify(script)}`, { stdio: 'pipe' });
      } catch (e) {
        const msg = e instanceof Error && 'stderr' in e
          ? String((e as { stderr: Buffer }).stderr)
          : String(e);
        throw new Error(`${t.name}/post-deploy.py has a Python syntax error:\n${msg}`);
      }
    });
  }
});
