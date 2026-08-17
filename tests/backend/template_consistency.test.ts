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
import { renderPodYaml } from '@/lib/template/render';
import { findGpuMultiContainerError } from '@/lib/services/podSchema';
import { buildProxyHosts } from '@/lib/stackInstall/postInstall';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');
const SRC_DIR = path.join(REPO_ROOT, 'packages', 'frontend', 'src');
// Phase 3.3 (#764): backend code moved out of src/lib into the workspace
// package. Tests that grep for source patterns now look here.
const BACKEND_SRC = path.join(REPO_ROOT, 'packages', 'backend', 'src');

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
    // Templates that moved to mdopp/oscar (external registry) but are
    // still referenced by name by SB-side code that controls them
    // (e.g. the OSCAR pending-skills promote route restarts the
    // Hermes service after promoting a skill). The template doesn't
    // live in this repo any more, but the service name on the agent
    // is still 'hermes' — the reference is legitimate. See #1159.
    'hermes',
    // Service identifiers used as getServiceFiles() fixtures in
    // ServiceManager.test.ts for the .container Quadlet resolution path
    // (#1778): 'ollama' is a real `.container`-Quadlet service (no
    // templates/ dir — it ships as an oscar GPU-fixup unit) and 'dual'
    // is a synthetic fixture name for the both-.kube-and-.container case.
    'ollama',
    'dual',
  ]);

  // Patterns to scan for in src/ — each captures a template-name string literal.
  const PATTERNS: { name: string; re: RegExp }[] = [
    { name: "isSelected(...)",          re: /isSelected\(\s*['"]([^'"]+)['"]\s*\)/g },
    { name: "getServiceFiles(node, X)", re: /getServiceFiles\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g },
    { name: "restartService(node, X)",  re: /restartService\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g },
  ];

  it('every template-name string in src/ resolves to an existing template', () => {
    const offenders: { file: string; pattern: string; name: string }[] = [];
    for (const file of [...walkSourceFiles(SRC_DIR), ...walkSourceFiles(BACKEND_SRC), ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'frontend', 'src'))]) {
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
    const wizardPath = path.join(REPO_ROOT, 'packages', 'frontend', 'src', 'components', 'OnboardingWizard.tsx');
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

  it('every template.yml has a strictly-valid manifest (#585)', async () => {
    // Drives every annotation rule through the single source of truth
    // in src/lib/template/contract.ts. Catches missing labels, invalid
    // tiers, malformed schema-versions, and the config-mount-required-
    // when-mustache-configs-present rule in one pass. Specific shape
    // violations get their own dedicated tests below.
    const { parseTemplateManifest } = await import('@/lib/template/contract');
    const offenders: string[] = [];
    for (const t of templates) {
      const result = parseTemplateManifest(t.yamlContent, {
        hasMustacheConfigs: Object.keys(t.configs).length > 0,
      });
      if (!result.ok) {
        for (const err of result.errors) {
          offenders.push(`${t.name}: ${err}`);
        }
      }
    }
    expect(
      offenders,
      `Templates with invalid manifests:\n  ${offenders.join('\n  ')}`,
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

// ─── 2b. …and every declared variable is actually used ──────────────────────
//
// The mirror image of rule 2, and the guard #2425 asked for. A template that
// DECLARES a variable it never renders makes the wizard collect a value that
// goes nowhere — `templates/nginx/variables.json`'s PUBLIC_DOMAIN was exactly
// that (declared, referenced in no nginx file, deleted in #2425), and the
// orphaned `ABS_*` variables of #2381 were the same shape one release earlier.
// Without an assertion, an orphan reappears silently on the next edit.
describe('Declared template variables are used', () => {
  /** Files inside a template dir that can legitimately consume a variable:
   *  the pod manifest, companion mustache configs, and the host-side
   *  post-deploy / entrypoint scripts (which read them as env vars, not as
   *  `{{...}}`). Deliberately EXCLUDES `variables.json` itself (the
   *  declaration is not a use) and the `migrations/` + `*.md` files (a
   *  historical note naming a retired variable must not keep it alive). */
  const USE_BEARING_EXT = /\.(ya?ml|mustache|py|sh|conf|json)$/;

  function usageBlob(templateName: string): string {
    const dir = path.join(TEMPLATES_DIR, templateName);
    const parts: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === 'variables.json') continue;
      if (!USE_BEARING_EXT.test(entry.name)) continue;
      parts.push(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
    }
    return parts.join('\n');
  }

  for (const t of templates) {
    it(`${t.name}: every declared variable is rendered or read somewhere`, () => {
      const blob = usageBlob(t.name);
      const orphans = Object.entries(t.variables)
        // `type: subdomain` vars are consumed STRUCTURALLY by the platform
        // (buildProxyHosts turns them into NPM proxy hosts) rather than by a
        // `{{...}}` reference, so absence from the template's own files is
        // expected and correct — e.g. auth's LLDAP_SUBDOMAIN (#2381).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(([, spec]) => (spec as any)?.type !== 'subdomain')
        .map(([name]) => name)
        .filter(name => !blob.includes(name));

      expect(
        orphans,
        `${t.name}: ${orphans.length} declared-but-unused variable(s):\n  ${orphans.join(', ')}\n\n` +
        `The wizard would collect a value that nothing consumes. Either reference it in ` +
        `${t.name}/template.yml, a *.mustache config or post-deploy.py — or delete the ` +
        `declaration from ${t.name}/variables.json. If it is a shared global (PUBLIC_DOMAIN, ` +
        `DATA_DIR, LLDAP_*), declare it ONCE in templates/settings.json instead (#2425).`,
      ).toEqual([]);
    });
  }
});

// ─── 2c. …and no default hardcodes one deployment's domain ──────────────────
//
// A `variables.json` default is what actually reaches a fresh install, so a
// concrete domain in one makes every other operator's box point at (or be
// rooted under) someone else's namespace. #2425 removed the literal
// `dopp.cloud` defaults; #2439 found the same value still sitting in four
// LLDAP_BASE_DN defaults, DN-encoded, where a `dopp.cloud` grep could not see
// it. This rule catches BOTH encodings — and any future maintainer's domain,
// not just this one — by allowing only the reserved names in a default:
// documentation domains (RFC 2606) and the LAN/link-local suffixes.
describe('Template variable defaults carry no concrete domain', () => {
  /** Reserved last labels a default may legitimately end on: RFC 2606
   *  documentation/test names, plus the LAN suffixes ServiceBay itself uses
   *  (`localhost`, podman's `host.containers.internal`, `dc=local`). */
  const RESERVED_TLD = new Set([
    'example', 'test', 'invalid', 'localhost', 'local', 'internal', 'lan', 'arpa',
  ]);
  /** A dotted DNS name whose last label is alphabetic — excludes IPs
   *  (`169.254.1.2`), version strings (`v1.1.0`) and unix paths. */
  const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,})\b/g;
  /** An LDAP DN written as `dc=` components — the encoding #2439 missed. */
  const DN_RE = /dc=([a-z0-9-]+)(?:\s*,\s*dc=([a-z0-9-]+))*/g;

  /** Every offending domain-shaped literal in one default value. */
  function offendingLiterals(value: string): string[] {
    const bad: string[] = [];
    for (const m of value.toLowerCase().matchAll(DOMAIN_RE)) {
      if (!RESERVED_TLD.has(m[1])) bad.push(m[0]);
    }
    for (const m of value.toLowerCase().matchAll(DN_RE)) {
      const labels = [...m[0].matchAll(/dc=([a-z0-9-]+)/g)].map(x => x[1]);
      // A DN roots an LDAP tree; the same reserved-name rule applies to its
      // last component (`dc=example,dc=com` is fine, `dc=local` is fine).
      if (labels.length > 1 && !RESERVED_TLD.has(labels[labels.length - 1])) bad.push(m[0]);
    }
    return bad;
  }

  /** name → default, for one variables.json-shaped object. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function defaultsOf(vars: Record<string, any>): [string, string][] {
    return Object.entries(vars)
      .filter(([, spec]) => typeof spec?.default === 'string' && spec.default !== '')
      .map(([name, spec]) => [name, spec.default as string]);
  }

  for (const t of templates) {
    it(`${t.name}: no variables.json default hardcodes a real domain`, () => {
      const offenders = defaultsOf(t.variables)
        .flatMap(([name, def]) => offendingLiterals(def).map(lit => `${name} = "${def}" (${lit})`));
      expect(
        offenders,
        `${t.name}: default(s) carrying one deployment's domain:\n  ${offenders.join('\n  ')}\n\n` +
        `A default ships to every install. Leave it empty and derive the value ` +
        `(LLDAP_BASE_DN derives from PUBLIC_DOMAIN in manifestAssembler, #2439), or use ` +
        `an RFC 2606 documentation name (example.com) in the description instead.`,
      ).toEqual([]);
    });
  }

  it('templates/settings.json globals hardcode no real domain', () => {
    const settings = JSON.parse(
      fs.readFileSync(path.join(TEMPLATES_DIR, 'settings.json'), 'utf-8'),
    );
    const offenders = defaultsOf(settings.variables ?? {})
      .flatMap(([name, def]) => offendingLiterals(def).map(lit => `${name} = "${def}" (${lit})`));
    expect(offenders, `settings.json globals with a hardcoded domain:\n  ${offenders.join('\n  ')}`)
      .toEqual([]);
  });
});

/** Build a Mustache view that supplies a value for every variable referenced
 *  by any template. Defaults from variables.json win; otherwise stub strings.
 *  For section blocks (`{{#X}}...`) Mustache reads the value's truthiness;
 *  defaults like '' would skip the block, which matches reality. */
function buildTemplateRenderView(): Record<string, string> {
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
  // RSA private key is multi-line and pre-indented in the real wizard. Just
  // give it a plausible single-line stub for parse-time validation.
  view.AUTHELIA_OIDC_RSA_PRIVATE_KEY = '          -----BEGIN STUB-----\n          stub\n          -----END STUB-----';
  return view;
}

// ─── 3. Each template renders to a valid Pod ────────────────────────────────
describe('Templates render to valid Pod manifests', () => {
  const view = buildTemplateRenderView();
  // ZWAVE_DEVICE acts as a section gate — when truthy, the home-assistant
  // template emits the Z-Wave container. Setting it to a fake path exercises
  // *more* of the YAML in the test, which is what we want.
  view.ZWAVE_DEVICE = '/dev/serial/by-id/stub-zwave';

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

// ─── 3a2. GPU passthrough is single-container-only (#2517) ──────────────────
// `podman kube play` silently drops `resources.limits` outside cpu/memory, and
// the escape hatch (a `.container` Quadlet with `AddDevice=nvidia.com/gpu=all`,
// #1026) is one container per unit — so a multi-container pod can never get a
// GPU, it just deploys healthy and runs on CPU with no error anywhere.
//
// The runtime gate is `validatePodManifest` (POST/PUT /api/services), which
// covers every install regardless of which registry the template came from.
// This is the PR-time half: a template shipped from THIS repo can't introduce
// the shape in the first place, and the author sees it in `npm test` rather
// than on the box. Same rule, same function — one source of truth.
describe('GPU passthrough: shipped templates stay single-container (#2517)', () => {
  // Model "the operator opted into GPU, everything else at defaults": force
  // only the GPU section gates truthy. Forcing *every* section on would report
  // containers a real GPU deploy would never emit (e.g. the Z-Wave container).
  const gpuView = buildTemplateRenderView();
  for (const v of catalogVars) {
    if (/GPU/.test(v)) gpuView[v] = 'yes';
  }

  for (const t of templates) {
    it(`${t.name}: no GPU limit in a multi-container pod`, () => {
      const rendered = Mustache.render(t.yamlContent, gpuView);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pod = (yaml.loadAll(rendered) as any[]).find(d => d?.kind === 'Pod');
      const err = findGpuMultiContainerError(pod);
      expect(err, err ? `${t.name}: ${err.path} — ${err.message}` : '').toBeNull();
    });
  }
});

// ─── 3b. Home Assistant base configuration.yaml wiring (#1687) ──────────────
describe('Home Assistant base configuration.yaml ships the include wiring', () => {
  const ha = templates.find(t => t.name === 'home-assistant')!;

  it('the base config ships automation/script/scene !include lines', () => {
    const cfg = ha.configs['configuration.yaml.mustache'];
    expect(cfg, 'home-assistant must ship configuration.yaml.mustache').toBeTruthy();
    expect(cfg).toMatch(/^automation: !include automations\.yaml$/m);
    expect(cfg).toMatch(/^script: !include scripts\.yaml$/m);
    expect(cfg).toMatch(/^scene: !include scenes\.yaml$/m);
    // ServiceBay's required wiring is still present on a fresh install.
    expect(cfg).toMatch(/^auth_oidc:/m);
    // …but NOT an `http:` block (#2573). HA 2026.8 keeps that setting in its
    // own store and raises a permanent repair issue while the YAML block
    // survives, so post-deploy.py sets it via HA's `http/config/configure`
    // websocket command instead of this file re-seeding it every deploy.
    expect(cfg).not.toMatch(/^http:/m);
  });

  it('every !include target file is shipped so the include never dangles', () => {
    for (const f of ['automations.yaml', 'scripts.yaml', 'scenes.yaml']) {
      expect(
        ha.configs[`${f}.mustache`],
        `home-assistant must ship ${f}.mustache so the !include target exists on first install`,
      ).toBeDefined();
    }
  });
});

// ─── 3b2. Auth template: LLDAP web UI bound to loopback (#2380) ─────────────
describe('Auth template: LLDAP HTTP port is loopback-bound (#2380)', () => {
  const auth = templates.find(t => t.name === 'auth')!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lldapContainer = (): any => {
    const view: Record<string, string> = {};
    for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
    for (const [name, meta] of Object.entries(auth.variables)) {
      if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
        view[name] = meta.default;
      }
    }
    const rendered = Mustache.render(auth.yamlContent, view);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pod = yaml.loadAll(rendered).find((d: any) => d?.kind === 'Pod') as any;
    return (pod?.spec?.containers ?? []).find((c: { name: string }) => c.name === 'lldap');
  };

  it('binds LLDAP_HTTP_HOST to 127.0.0.1 so the admin UI/API is not LAN-reachable', () => {
    // The auth pod is hostNetwork: true, so LLDAP's default http_host of
    // 0.0.0.0 means EVERY host interface — the admin web UI and
    // /api/graphql answered at <lan-ip>:17170 without ever passing through
    // nginx, and therefore without Authelia's admin-group + 2FA gate.
    // A hostNetwork pod publishes no ports, so unlike radicale's
    // `hostIP: 127.0.0.1` (#2357) the bind address must come from the app's
    // own config. This is the assertion that keeps it there.
    const env: { name: string; value: string }[] = lldapContainer()?.env ?? [];
    expect(env.find(e => e.name === 'LLDAP_HTTP_HOST')?.value).toBe('127.0.0.1');
  });

  it('leaves the raw LDAP port bound to every interface, and closes it at the HOST firewall instead (#2388)', () => {
    // The bind stays 0.0.0.0 on purpose, and that is still a tripwire:
    // isolated pods reach this port through host.containers.internal,
    // which rootless podman/pasta maps to the host's LAN address rather
    // than loopback, so an LLDAP_LDAP_HOST=127.0.0.1 here would break
    // radicale's ldap_uri and Jellyfin's LDAP-Auth plugin. If someone
    // "completes" #2380 by adding the var, read #2388 first.
    const env: { name: string; value: string }[] = lldapContainer()?.env ?? [];
    expect(env.map(e => e.name)).not.toContain('LLDAP_LDAP_HOST');
    expect(auth.variables.LLDAP_LDAP_PORT.description).toMatch(/#2388/);
    // #2388 closes the LAN half outside the pod: the port variable opts
    // into the host nftables filter, which drops connections arriving on
    // a physical interface while accepting the ones arriving on `lo`
    // (where the pasta-proxied pod path lands). Dropping this flag
    // silently re-opens the LAN exposure with no other failing test.
    expect(auth.variables.LLDAP_LDAP_PORT.blockLanAccess).toBe(true);
    // The web-UI port must NOT carry it — that one is loopback-bound
    // already (#2380), so a host rule would be redundant privileged state.
    expect(auth.variables.LLDAP_PORT.blockLanAccess).toBeUndefined();
  });

  it('points ldap.<domain> at the loopback while keeping forward-auth', () => {
    // nginx runs on hostNetwork, so `loopbackOnly` (forwardHost 127.0.0.1)
    // is what keeps the proxied route working — and re-points an EXISTING
    // host off the now-closed LAN address on redeploy (#2364). The
    // forward-auth sentinel must survive: it is the only gate left.
    expect(auth.variables.LLDAP_SUBDOMAIN.loopbackOnly).toBe(true);
    expect(auth.variables.LLDAP_SUBDOMAIN.proxyPort).toBe('LLDAP_PORT');
    expect(auth.variables.LLDAP_SUBDOMAIN.proxyConfig.advanced_config)
      .toBe('__authelia_forward_auth__');
  });

  it('ships a CHANGELOG section and a v2-to-v3 migration for the loopback bind', () => {
    const changelog = fs.readFileSync(path.join(TEMPLATES_DIR, 'auth', 'CHANGELOG.md'), 'utf-8');
    expect(changelog).toMatch(/##\s*v3\b.*\(breaking\)/);
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'auth', 'migrations', 'v2-to-v3.py'), 'utf-8',
    );
    // Informational hop — it must not touch LLDAP's users.db or any data.
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    expect(mig).toMatch(/untouched/i);
  });

  it('the smoke script no longer expects LLDAP on the box LAN address', () => {
    // scripts/smoke/sso-verify.sh ran ~9 LLDAP API curls at
    // http://$HOST:$LLDAP_PORT. Those break the moment the bind moves, so
    // they now tunnel over SSH to the box's loopback (`lldap_api`). The one
    // remaining use of the LAN address is the NEGATIVE probe asserting the
    // port is refused there.
    const smoke = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'smoke', 'sso-verify.sh'), 'utf-8',
    );
    expect(smoke).toMatch(/lldap_api\(\)/);
    expect(smoke).toMatch(/http:\/\/127\.0\.0\.1:\$\{LLDAP_PORT\}/);
    // No `curl ... "http://$HOST:$LLDAP_PORT/api/..."`-style API call left.
    expect(smoke).not.toMatch(/\$HOST:\$LLDAP_PORT\/(api|auth)\b/);
  });

  // ─── #2417: the servicebay OIDC client's secret is per-install ──────────
  //
  // This client guards the admin panel itself. A literal here is a credential
  // every box on earth shares, and `mergeAutheliaOidcClients`'s no-rotate rule
  // means it never self-heals. These assertions are the ratchet: the literal
  // cannot come back, and the variable that replaced it cannot be quietly
  // dropped or downgraded to a non-secret.
  it('renders the servicebay OIDC client_secret from a per-install secret variable', () => {
    const mustache = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'auth', 'configuration.yml.mustache'), 'utf-8',
    );
    // The client is still declared…
    expect(mustache).toMatch(/client_id:\s*'servicebay'/);
    // …but its secret is a placeholder, not a value.
    expect(mustache).toMatch(/client_secret:\s*'\$plaintext\$\{\{SERVICEBAY_OIDC_SECRET\}\}'/);
    // No `$plaintext$<literal>` anywhere in the rendered config.
    expect(mustache).not.toMatch(/\$plaintext\$[A-Za-z0-9_-]/);

    // Declared as a generated secret, like every sibling SSO template's.
    expect(auth.variables.SERVICEBAY_OIDC_SECRET?.type).toBe('secret');
    // `noAutoGenerate` would leave it EMPTY, rendering an empty client_secret
    // — Authelia would then accept any secret for this client.
    expect(auth.variables.SERVICEBAY_OIDC_SECRET?.noAutoGenerate).toBeFalsy();
    expect(auth.variables.SERVICEBAY_OIDC_SECRET?.default).toBeUndefined();
  });

  it('schema-version is bumped to 4 with a CHANGELOG section and a v3-to-v4 migration', () => {
    // Without the bump, an existing box never re-renders configuration.yml and
    // keeps the published secret forever.
    expect(auth.yamlContent).toMatch(/servicebay\.schema-version:\s*"4"/);
    const changelog = fs.readFileSync(path.join(TEMPLATES_DIR, 'auth', 'CHANGELOG.md'), 'utf-8');
    expect(changelog).toMatch(/##\s*v4\b.*\(breaking\)/);
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'auth', 'migrations', 'v3-to-v4.py'), 'utf-8',
    );
    // Informational hop: the rotation is structural (the re-render owns it),
    // so this script must not move data or try to write either side itself —
    // a script that flipped ServiceBay's copy here would lead the file instead
    // of following it, which is the ordering that CAN strand a box.
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    expect(mig).toMatch(/break-glass|LOCAL admin/i);
  });
});

// ─── 3b2a. hostNetwork templates expose no unguarded admin/control port ─────
describe('hostNetwork templates: every declared TCP port is guarded (#2416)', () => {
  // A `hostNetwork: true` pod publishes no ports — whatever its containers
  // bind, they bind on EVERY host interface, and Fedora CoreOS ships no
  // firewall. So every TCP port such a template declares in
  // `servicebay.ports` is LAN-reachable by default, with nginx (and with it
  // Authelia) bypassed entirely. That is one bug class hit three times on
  // three templates: #2380 (LLDAP web UI), #2388 (raw LDAP port), #2416
  // (Z-Wave JS UI + its raw control websocket + the Matter websocket).
  //
  // This test turns the class into a structural rule. A declared TCP port
  // passes only if it is:
  //   (a) covered by a `loopbackOnly: true` subdomain variable — nginx also
  //       runs on hostNetwork, so it forwards to 127.0.0.1 and the app is
  //       expected to bind the loopback (we check the template ships such a
  //       bind, which is exactly the half #2380 was missing); or
  //   (b) covered by a `blockLanAccess: true` port variable — the host
  //       nftables rule for ports that CANNOT be loopback-bound (#2388); or
  //   (c) listed in HOST_NETWORK_PORT_POLICY below with a written reason,
  //       and — for a port claimed loopback-bound without a proxy host — a
  //       `bind` proof pointing at the config that actually binds it.
  //
  // Adding a port to a hostNetwork template without doing one of those three
  // fails this suite. Deleting the guard from an existing one does too.
  interface PortPolicy {
    policy: 'loopback-bound' | 'lan-exposed';
    why: string;
    /** `loopback-bound` only: file (relative to the template dir) + pattern
     *  proving the bind is actually configured, not just asserted here. */
    bind?: { file: string; pattern: RegExp };
  }

  const HOST_NETWORK_PORT_POLICY: Record<string, PortPolicy> = {
    // — Ports that are meant to answer on the LAN, each with its own auth —
    'adguard:8083': {
      policy: 'lan-exposed',
      why: 'AdGuard Home admin UI. Its own login (post-deploy sets the admin '
        + 'password) and it is the console for the box DNS server, which has to '
        + 'stay reachable when the proxy is down.',
    },
    'adguard:53': {
      policy: 'lan-exposed',
      why: 'DNS over TCP. Serving the LAN is the entire job of the service — '
        + 'every device on the network resolves through it.',
    },
    'auth:9091': {
      policy: 'lan-exposed',
      why: 'The Authelia portal itself — it IS the login surface, so gating it '
        + 'behind itself is circular. Every app redirects here.',
    },
    // NOTE: `claude-dev:2222` used to live here. It is gone because the
    // template no longer runs hostNetwork (#2522) — this policy map is only
    // consulted for hostNetwork pods, so the entry had become dead code. The
    // equivalent reasoning for its (still deliberate) 0.0.0.0 hostPort now
    // lives in the dedicated claude-dev suite further down this file.
    'file-share:22000': {
      policy: 'lan-exposed',
      why: 'Syncthing sync protocol. Peers connect device-to-device over TLS '
        + 'with device-ID authentication; loopback would break every peer.',
    },
    'file-share:139': {
      policy: 'lan-exposed',
      why: 'SMB (NetBIOS session). LAN file sharing is the point of the '
        + 'service; Samba authenticates users itself.',
    },
    'file-share:445': {
      policy: 'lan-exposed',
      why: 'SMB. Same as 139 — LAN by design, Samba-authenticated.',
    },
    'file-share:8088': {
      policy: 'lan-exposed',
      why: 'FileBrowser. Runs in proxy-auth mode (auth.method=proxy with '
        + 'Remote-User), so a direct LAN request without the forward-auth header '
        + 'is rejected 403. It cannot be loopback-bound because NPM reaches it '
        + 'from its own pod netns.',
    },
    'home-assistant:8123': {
      policy: 'lan-exposed',
      why: 'Home Assistant itself. Has its own login plus the Authelia OIDC '
        + 'provider, is published at home.<domain>, and the companion apps talk '
        + 'to it directly on the LAN.',
    },
    'nginx:80': { policy: 'lan-exposed', why: 'The reverse proxy — this is the front door.' },
    'nginx:443': { policy: 'lan-exposed', why: 'The reverse proxy — this is the front door.' },
    'nginx:81': {
      policy: 'lan-exposed',
      why: "NPM's admin UI. Own login, and it is the recovery console for the "
        + 'proxy itself, so it must survive a broken proxy config.',
    },

    // — Loopback-bound ports with no proxy host of their own (#2416) —
    'home-assistant:3001': {
      policy: 'loopback-bound',
      why: 'Raw Z-Wave JS server protocol — no authentication of any kind, so '
        + 'LAN reach means LAN control of every paired device, door locks '
        + 'included. Home Assistant shares this pod and connects over '
        + 'ws://localhost:3001, so nothing legitimate needs the LAN path.',
      bind: { file: 'post-deploy.py', pattern: /^ZWAVEJS_WS_HOST = "127\.0\.0\.1"$/m },
    },
    'home-assistant:5580': {
      policy: 'loopback-bound',
      why: "python-matter-server's control websocket — likewise unauthenticated. "
        + 'Home Assistant connects over ws://localhost:5580/ws. --listen-address '
        + 'binds only the websocket API server, never the CHIP/Matter stack, so '
        + 'commissioning and device traffic are unaffected.',
      bind: { file: 'template.yml', pattern: /- "--listen-address"\n\s*- "127\.0\.0\.1"/ },
    },
  };

  /** A YAML *value* (not a comment) binding something to the loopback. */
  const LOOPBACK_BIND = /(value:\s*"127\.0\.0\.1|^\s*-\s*"127\.0\.0\.1)/m;

  /** Render a template with variable defaults, like the sibling suites do. */
  const renderPod = (t: TemplateInfo): // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any => {
    const view: Record<string, string> = {};
    for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
    for (const [name, meta] of Object.entries(t.variables)) {
      if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
        view[name] = meta.default;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return yaml.loadAll(Mustache.render(t.yamlContent, view)).find((d: any) => d?.kind === 'Pod');
  };

  /** Resolve a subdomain's proxyPort to a number (literal or via variable). */
  const resolvePort = (t: TemplateInfo, proxyPort: string | undefined): number | null => {
    if (!proxyPort) return null;
    if (/^\d+$/.test(proxyPort)) return parseInt(proxyPort, 10);
    const local = t.variables[proxyPort];
    const fromLocal = local && typeof local === 'object' ? local.default : undefined;
    if (typeof fromLocal === 'string' && /^\d+$/.test(fromLocal)) return parseInt(fromLocal, 10);
    for (const other of templates) {
      const meta = other.variables[proxyPort];
      const d = meta && typeof meta === 'object' ? meta.default : undefined;
      if (typeof d === 'string' && /^\d+$/.test(d)) return parseInt(d, 10);
    }
    return null;
  };

  const hostNetworkTemplates = templates.filter(t => renderPod(t)?.spec?.hostNetwork === true);

  it('there is at least one hostNetwork template to check', () => {
    // Guards against the rule silently becoming a no-op if rendering breaks.
    expect(hostNetworkTemplates.length).toBeGreaterThan(0);
  });

  for (const t of hostNetworkTemplates) {
    it(`${t.name}: every declared TCP port is loopback-bound, firewalled, or reasoned`, () => {
      const pod = renderPod(t);
      const declared: string = pod?.metadata?.annotations?.['servicebay.ports'] ?? '';
      const tcpPorts = declared.split(',')
        .map(p => p.trim())
        .filter(p => p.toLowerCase().endsWith('/tcp'))
        .map(p => parseInt(p.split('/')[0], 10))
        .filter(p => Number.isFinite(p));

      // Ports a `loopbackOnly` subdomain or a `blockLanAccess` variable covers.
      const loopbackPorts = new Set<number>();
      const firewalledPorts = new Set<number>();
      for (const meta of Object.values(t.variables)) {
        if (!meta || typeof meta !== 'object') continue;
        if (meta.loopbackOnly) {
          const p = resolvePort(t, meta.proxyPort);
          if (p !== null) loopbackPorts.add(p);
        }
        if (meta.blockLanAccess && typeof meta.default === 'string' && /^\d+$/.test(meta.default)) {
          firewalledPorts.add(parseInt(meta.default, 10));
        }
      }

      const offenders: string[] = [];
      for (const port of tcpPorts) {
        if (firewalledPorts.has(port)) continue;
        if (loopbackPorts.has(port)) {
          // The proxy half is declared; assert the app-bind half exists too —
          // that is precisely the half #2380 shipped without.
          expect(
            t.yamlContent,
            `${t.name}: a subdomain declares loopbackOnly for port ${port}, but `
            + `${t.name}/template.yml never binds anything to 127.0.0.1. The proxy `
            + `would forward to a loopback nothing listens on, and the LAN path `
            + `would still be open.`,
          ).toMatch(LOOPBACK_BIND);
          continue;
        }
        const policy = HOST_NETWORK_PORT_POLICY[`${t.name}:${port}`];
        if (!policy) {
          offenders.push(
            `${t.name}:${port} — hostNetwork pod, so this port answers on every `
            + `host interface with no proxy and no SSO in front of it.`,
          );
          continue;
        }
        expect(policy.why.length, `${t.name}:${port} policy needs a written reason`).toBeGreaterThan(20);
        if (policy.policy === 'loopback-bound') {
          expect(
            policy.bind,
            `${t.name}:${port} claims loopback-bound — give it a bind proof so the `
            + `claim is checked rather than asserted.`,
          ).toBeTruthy();
          const proof = fs.readFileSync(path.join(TEMPLATES_DIR, t.name, policy.bind!.file), 'utf-8');
          expect(
            proof,
            `${t.name}:${port} is declared loopback-bound but `
            + `templates/${t.name}/${policy.bind!.file} no longer configures that bind `
            + `(${policy.bind!.pattern}). The port is LAN-reachable again.`,
          ).toMatch(policy.bind!.pattern);
        }
      }

      expect(
        offenders,
        `${t.name}: unguarded admin/control port(s) on a hostNetwork pod:\n  `
        + `${offenders.join('\n  ')}\n\n`
        + `Close it one of three ways:\n`
        + `  1. Bind the app to 127.0.0.1 in template.yml and add \`loopbackOnly: true\`\n`
        + `     to the subdomain variable that proxies it (prior art: auth #2380,\n`
        + `     home-assistant #2416).\n`
        + `  2. If it cannot be loopback-bound, add \`blockLanAccess: true\` to the port\n`
        + `     variable so ServiceBay installs the host nftables rule (prior art: #2388).\n`
        + `  3. If it genuinely has to answer on the LAN, add an entry to\n`
        + `     HOST_NETWORK_PORT_POLICY in this file saying why, and what authenticates it.`,
      ).toEqual([]);
    });
  }
});

// ─── 3b2b. Home Assistant: Z-Wave + Matter control ports loopback (#2416) ───
describe('Home Assistant template: Z-Wave and Matter ports are loopback-bound (#2416)', () => {
  const ha = templates.find(t => t.name === 'home-assistant')!;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container = (name: string): any => {
    const view: Record<string, string> = {};
    for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
    for (const [n, meta] of Object.entries(ha.variables)) {
      if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
        view[n] = meta.default;
      }
    }
    const rendered = Mustache.render(ha.yamlContent, view);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pod = yaml.loadAll(rendered).find((d: any) => d?.kind === 'Pod') as any;
    return (pod?.spec?.containers ?? []).find((c: { name: string }) => c.name === name);
  };

  const postDeploy = (): string =>
    fs.readFileSync(path.join(TEMPLATES_DIR, 'home-assistant', 'post-deploy.py'), 'utf-8');

  it('binds the Z-Wave JS UI web server to 127.0.0.1 via HOST', () => {
    // The pod is hostNetwork: true and zwave-js-ui reads an empty HOST as
    // "every IPv4 and IPv6 interface", so the admin panel — add/remove nodes,
    // read the network security keys — answered at <lan-ip>:8091 without ever
    // passing through nginx, and therefore without Authelia's forward-auth.
    const env: { name: string; value: string }[] = container('zwave-js')?.env ?? [];
    expect(env.find(e => e.name === 'HOST')?.value).toBe('127.0.0.1');
  });

  it('points zwave.<domain> at the loopback while keeping forward-auth', () => {
    // nginx runs on hostNetwork, so `loopbackOnly` (forwardHost 127.0.0.1) is
    // what keeps the proxied route working — and re-points an EXISTING host
    // off the now-closed LAN address on redeploy (#2364). The forward-auth
    // sentinel must survive: it is the only gate left.
    expect(ha.variables.ZWAVE_JS_SUBDOMAIN.loopbackOnly).toBe(true);
    expect(ha.variables.ZWAVE_JS_SUBDOMAIN.proxyPort).toBe('8091');
    expect(ha.variables.ZWAVE_JS_SUBDOMAIN.proxyConfig.advanced_config)
      .toBe('__authelia_forward_auth__');
  });

  it('seeds the raw Z-Wave control websocket on 127.0.0.1, not 0.0.0.0', () => {
    // Port 3001 speaks the zwave-js server protocol with no auth at all — LAN
    // reach is LAN control of every paired device. HA lives in this same pod
    // and connects over ws://localhost:3001, so the loopback bind costs it
    // nothing. The bind lives in post-deploy's seeded settings file, not in
    // the pod manifest, which is why it needs its own assertion.
    expect(postDeploy()).toMatch(/^ZWAVEJS_WS_HOST = "127\.0\.0\.1"$/m);
    expect(postDeploy()).toMatch(/ws:\/\/localhost:\{ZWAVEJS_WS_PORT\}/);
  });

  it('re-pins an existing settings file that still carries a wildcard bind', () => {
    // The seeder only writes the external-settings file when it is MISSING, so
    // every pre-v7 install already has one saying 0.0.0.0. Without an in-place
    // repair the bind constant above would never reach those boxes.
    const src = postDeploy();
    expect(src).toMatch(/def repair_zwave_external_settings_host\(/);
    expect(src).toMatch(/def repair_zwave_ui_settings_host\(/);
    expect(src).toMatch(/ZWAVEJS_WS_WILDCARD_HOSTS/);
  });

  it('binds the Matter websocket to 127.0.0.1 without touching the CHIP stack', () => {
    // `args` REPLACES the image CMD, so the image's own defaults have to be
    // repeated — dropping them would start matter-server with no storage path.
    const args: string[] = container('matter-server')?.args ?? [];
    expect(args).toEqual([
      '--storage-path', '/data',
      '--paa-root-cert-dir', '/data/credentials',
      '--listen-address', '127.0.0.1',
    ]);
  });

  it('declares the Matter websocket port so the network map can see it', () => {
    // 5580 was bound on every interface AND undeclared, so it was invisible.
    expect(ha.yamlContent).toMatch(/servicebay\.ports:\s*"8123\/tcp,8091\/tcp,3001\/tcp,5580\/tcp"/);
  });

  it('the v6-to-v7 hop stays in place with its CHANGELOG section and migration', () => {
    // Pinned as "at least 7", not "exactly 7": later hops (v8 = #2573) must be
    // free to land without re-opening this #2416 guard, but the template can
    // never fall back below the hop that moved these binds to loopback.
    const declared = ha.yamlContent.match(/servicebay\.schema-version:\s*"(\d+)"/);
    expect(declared, 'home-assistant must declare a schema-version').toBeTruthy();
    expect(Number(declared![1])).toBeGreaterThanOrEqual(7);
    const changelog = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'home-assistant', 'CHANGELOG.md'), 'utf-8',
    );
    expect(changelog).toMatch(/##\s*v7\b.*\(breaking\)/);
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'home-assistant', 'migrations', 'v6-to-v7.py'), 'utf-8',
    );
    // Config-only hop: it rewrites one JSON key and must not move or delete
    // anything on disk (HA's /config, the zwave-js store, matter-server data).
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    expect(mig).toMatch(/untouched/i);
    // Unlike auth's v2-to-v3 this hop is NOT informational — 3001's bind is
    // on-disk state the seeder will not rewrite, so the migration must.
    expect(mig).toMatch(/serverHost/);
    expect(mig).toMatch(/def migrate_zwave_ws_bind\(/);
  });
});

// ─── 3b3. Radicale template: rights ruleset is baked in (#2411) ─────────────
describe('Radicale template: rights ruleset (#2411)', () => {
  const radicale = templates.find(t => t.name === 'radicale')!;

  /** Render the pod and return the write-config initContainer's shell script. */
  const initScript = (): string => {
    const view: Record<string, string> = {};
    for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
    for (const [name, meta] of Object.entries(radicale.variables)) {
      if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
        view[name] = meta.default;
      }
    }
    const rendered = Mustache.render(radicale.yamlContent, view);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pod = yaml.loadAll(rendered).find((d: any) => d?.kind === 'Pod') as any;
    const init = (pod?.spec?.initContainers ?? []).find((c: { name: string }) => c.name === 'write-config');
    return (init?.args ?? []).join('\n');
  };

  /** Pull one `cat > <file> <<'EOF' … EOF` heredoc body out of that script. */
  const heredoc = (file: string): string => {
    const lines = initScript().split('\n');
    const start = lines.findIndex(l => l.startsWith(`cat > ${file} <<`));
    expect(start, `no heredoc writing ${file} in the write-config initContainer`).toBeGreaterThanOrEqual(0);
    const end = lines.indexOf('EOF', start + 1);
    expect(end, `unterminated heredoc for ${file}`).toBeGreaterThan(start);
    return lines.slice(start + 1, end).join('\n');
  };

  /** Minimal INI parse of a Radicale rights file, preserving section order. */
  const rules = (): { name: string; user: string; collection: string; permissions: string }[] => {
    const out: { name: string; user: string; collection: string; permissions: string }[] = [];
    for (const raw of heredoc('/config/rights').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const section = line.match(/^\[(.+)\]$/);
      if (section) {
        out.push({ name: section[1], user: '', collection: '', permissions: '' });
        continue;
      }
      const kv = line.match(/^([a-z]+)\s*:\s*(.*)$/);
      if (!kv || out.length === 0) continue;
      const cur = out[out.length - 1];
      if (kv[1] === 'user') cur.user = kv[2];
      else if (kv[1] === 'collection') cur.collection = kv[2];
      else if (kv[1] === 'permissions') cur.permissions = kv[2];
    }
    return out;
  };

  /**
   * Evaluate the ruleset the way Radicale's `from_file` rights backend does:
   * fullmatch the `user` pattern against the login, substitute that match's
   * capture groups into the `collection` pattern's `{N}` placeholders,
   * fullmatch it against the sanitised path — FIRST matching section wins,
   * everything else is a 403. `''` means no access.
   */
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const authorization = (user: string, collectionPath: string): string => {
    const path = collectionPath.replace(/^\/+|\/+$/g, '');
    for (const rule of rules()) {
      const userMatch = new RegExp(`^(?:${rule.user})$`).exec(user);
      if (!userMatch) continue;
      const pattern = rule.collection.replace(/\{(\d+)\}/g, (_m, i: string) =>
        escapeRe(userMatch[Number(i) + 1] ?? ''));
      if (new RegExp(`^(?:${pattern})$`).test(path)) return rule.permissions;
    }
    return '';
  };

  it('points [rights] at the generated /config/rights file instead of owner_only', () => {
    // owner_only is a built-in module with no way to express a single
    // cross-principal exception, so the household sync account had to be
    // granted by hand on the running pod — where /config is an in-pod
    // emptyDir, so the next `podman kube play --replace` wiped it.
    const config = heredoc('/config/config');
    expect(config).toMatch(/^\[rights\]$/m);
    expect(config).toMatch(/^type = from_file$/m);
    expect(config).toMatch(/^file = \/config\/rights$/m);
    expect(config).not.toMatch(/^type = owner_only$/m);
  });

  it('seeds /config/rights from the pod manifest, so it survives a re-render', () => {
    // The whole point of #2411: the ruleset is part of the manifest the
    // initContainer replays on EVERY deploy. If this heredoc ever moves
    // back out to a host file or a live patch, the rule silently reverts
    // the next time AutoUpdate=registry pulls an image.
    expect(rules().map(r => r.name)).toEqual([
      'root', 'owner', 'solaris-subcal', 'solaris-contacts',
    ]);
    for (const r of rules()) {
      expect(r.permissions, `section [${r.name}] declares no permissions`).not.toBe('');
    }
  });

  it('reproduces owner_only for a normal resident', () => {
    // [root] + [owner] must be behaviourally equivalent to the module they
    // replace: read on the root collection (so .well-known discovery still
    // resolves a principal), full access to your own subtree, nothing else.
    expect(authorization('mdopp', '/')).toBe('R');
    expect(authorization('mdopp', '/mdopp/')).toBe('RrWw');
    expect(authorization('mdopp', '/mdopp/calendar/')).toBe('RrWw');
    expect(authorization('mdopp', '/mdopp/solaris/')).toBe('RrWw');
    expect(authorization('mdopp', '/mdopp/solaris-contacts/')).toBe('RrWw');
    expect(authorization('mdopp', '/mdopp/calendar/event.ics')).toBe('RrWw');
    // …and no reach into another resident's tree, at any depth.
    expect(authorization('mdopp', '/alice/')).toBe('');
    expect(authorization('mdopp', '/alice/calendar/')).toBe('');
    expect(authorization('alice', '/mdopp/solaris-contacts/')).toBe('');
  });

  it('lets the solaris account write the shared calendar AND address book', () => {
    // The address-book half is the fix (#2411): before it, all three
    // plausible paths failed — /<resident>/solaris-contacts/ 403 (the
    // calendar rule matches `…/solaris` exactly), /<resident>/solaris/…
    // 403 (a calendar is a leaf), and /solaris/contacts/ landed in the
    // service account's own tree, which the resident may not read.
    expect(authorization('solaris', '/mdopp/solaris/')).toBe('RrWw');
    expect(authorization('solaris', '/mdopp/solaris-contacts/')).toBe('RrWw');
    expect(authorization('solaris', '/mdopp/solaris-contacts/card.vcf')).toBe('RrWw');
    // Lower-case letters are the ones that matter for MKCOL/MKCALENDAR on a
    // calendar/address-book collection; upper-case covers plain collections.
    expect(authorization('solaris', '/mdopp/solaris-contacts/')).toContain('w');
  });

  it('keeps the solaris account out of everything else', () => {
    // The grant stays two named collections wide. A resident's own
    // calendars, their principal root, and any other solaris-prefixed name
    // are all still 403 — which is why this is two explicit sections rather
    // than a widened `solaris(-[a-z]+)?` pattern.
    expect(authorization('solaris', '/mdopp/')).toBe('');
    expect(authorization('solaris', '/mdopp/eb58abcb-1234-5678-9abc-def012345678/')).toBe('');
    expect(authorization('solaris', '/mdopp/calendar/')).toBe('');
    expect(authorization('solaris', '/mdopp/contacts/')).toBe('');
    expect(authorization('solaris', '/mdopp/solaris-secrets/')).toBe('');
    expect(authorization('solaris', '/alice/')).toBe('');
    // Its own principal subtree is still its own — via [owner], like anyone.
    expect(authorization('solaris', '/solaris/')).toBe('RrWw');
  });

  it('schema-version is bumped to 3 with a CHANGELOG section and a v2-to-v3 migration', () => {
    expect(radicale.yamlContent).toMatch(/servicebay\.schema-version:\s*"3"/);
    const changelog = fs.readFileSync(path.join(TEMPLATES_DIR, 'radicale', 'CHANGELOG.md'), 'utf-8');
    expect(changelog).toMatch(/##\s*v3\b.*\(breaking\)/);
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'radicale', 'migrations', 'v2-to-v3.py'), 'utf-8',
    );
    // Config-only hop — no collection may be moved, renamed or deleted.
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    expect(mig).toMatch(/untouched/i);
  });
});

// ─── 3c. Media template retires Audiobookshelf for fresh installs (#1725) ───
describe('Media template: Audiobookshelf retired for fresh installs (#1725)', () => {
  const media = templates.find(t => t.name === 'media')!;

  // Minimal render view — only the vars the media pod references.
  const mediaView: Record<string, string> = {};
  for (const v of catalogVars) mediaView[v] = `stub-${v.toLowerCase()}`;
  for (const [name, meta] of Object.entries(media.variables)) {
    if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
      mediaView[name] = meta.default;
    }
  }
  mediaView.JELLYFIN_PORT = '8096';
  mediaView.DATA_DIR = '/mnt/data/stacks';
  mediaView.HOST_GATEWAY_IP = '10.88.0.1';
  mediaView.PUBLIC_DOMAIN = 'dopp.cloud';

  it('a fresh-install render has a Jellyfin container but no Audiobookshelf container', () => {
    const rendered = Mustache.render(media.yamlContent, mediaView);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pod = yaml.loadAll(rendered).find((d: any) => d?.kind === 'Pod') as any;
    const containerNames: string[] = (pod?.spec?.containers ?? []).map((c: { name: string }) => c.name);
    expect(containerNames).toContain('jellyfin');
    expect(containerNames).not.toContain('audiobookshelf');
    // No ABS volumes/ports leak into the rendered pod either.
    expect(JSON.stringify(pod)).not.toMatch(/audiobookshelf-config|abs-audiobooks|abs-podcasts/);
  });

  it('declares no ABS_* variables at all (#2381, #2561)', () => {
    // #1725/#1730 retired Audiobookshelf but left its variables declared, so
    // the install/edit wizard kept rendering "Abs Admin Password" &c. for a
    // container the pod no longer runs (#2381). `ABS_SUBDOMAIN` survived that
    // sweep because it still declared the `books.<domain>` proxy host v6 had
    // repointed at Jellyfin — v7 (#2561) ends that transitional arrangement,
    // so the last ABS_* variable is gone too.
    expect(Object.keys(media.variables).filter(n => n.startsWith('ABS_'))).toEqual([]);
  });

  it('a deploy can only create media.<domain> — the books route is structurally impossible (#2561)', () => {
    // The load-bearing proof that removing the declaration removes the route:
    // ServiceBay derives proxy hosts from `type: subdomain` DECLARATIONS via
    // buildProxyHosts, so feeding it exactly what the media template declares
    // is what a fresh deploy of `media` would create. Asserting the absence of
    // the declaration alone would not show that.
    const subdomainVars = Object.entries(media.variables)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(([, spec]) => (spec as any)?.type === 'subdomain');
    expect(subdomainVars.map(([name]) => name)).toEqual(['MEDIA_SUBDOMAIN']);

    const { hosts } = buildProxyHosts([
      { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
      { name: 'JELLYFIN_PORT', value: mediaView.JELLYFIN_PORT },
      ...subdomainVars.map(([name, spec]) => ({
        name,
        value: String(spec.default ?? ''),
        meta: { ...spec, templateName: 'media' },
      })),
    ]);
    expect(hosts.map(h => h.domain)).toEqual(['media.dopp.cloud']);
    expect(hosts[0].forwardPort).toBe(8096);
    expect(JSON.stringify(hosts)).not.toMatch(/books/);
  });

  it('schema-version is bumped to 7 with a matching CHANGELOG section', () => {
    expect(media.yamlContent).toMatch(/servicebay\.schema-version:\s*"7"/);
    const changelog = fs.readFileSync(path.join(TEMPLATES_DIR, 'media', 'CHANGELOG.md'), 'utf-8');
    expect(changelog).toMatch(/##\s*v7\b.*\(breaking\)/);
    // The operator's required action leads the section: they lose an address
    // and need to be told its replacement in the first sentence, not the last
    // (docs/TEMPLATE_AUTHORING.md).
    const v7 = changelog.slice(changelog.indexOf('## v7'), changelog.indexOf('## v6'));
    const lead = v7.split('###')[0];
    expect(lead).toMatch(/books\.<domain>/);
    expect(lead).toMatch(/media\.<domain>/);
  });

  it('the v5-to-v6 migration is non-destructive (leaves ABS data on disk)', () => {
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'media', 'migrations', 'v5-to-v6.py'), 'utf-8',
    );
    // The migration must NOT delete/move the ABS data dirs — it only informs.
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    expect(mig).toMatch(/UNTOUCHED|preserved/i);
  });

  it('the v6-to-v7 migration clears the stale books route and touches no data (#2561)', () => {
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'media', 'migrations', 'v6-to-v7.py'), 'utf-8',
    );
    // Removing the declaration stops FUTURE deploys creating the route, but
    // nothing prunes the host that already exists (the nginx capability
    // handler only creates on feature.installed; dangling_proxy ignores a
    // route whose target is alive). Hence the DELETE through ServiceBay's
    // own proxy-hosts endpoint.
    expect(mig).toMatch(/api\/system\/nginx\/proxy-hosts/);
    expect(mig).toMatch(/"DELETE"/);
    // Route cleanup only — no on-disk data may move.
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    // Best-effort like v5-to-v6: a leftover route must never abort a deploy.
    expect(mig).not.toMatch(/return 1|sys\.exit\(1\)/);
  });
});

// ─── 3d. claude-dev runs isolated, and SSH stays reachable (#2522) ──────────
describe('Claude Dev template: isolated netns, SSH reachability preserved (#2522)', () => {
  const claudeDev = templates.find(t => t.name === 'claude-dev')!;
  const auth = templates.find(t => t.name === 'auth')!;

  const view: Record<string, string> = {};
  for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
  for (const [name, meta] of Object.entries(claudeDev.variables)) {
    if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
      view[name] = meta.default;
    }
  }
  view.CLAUDE_DEV_SSH_PORT = '2222';
  view.LLDAP_LDAP_PORT = '3890';
  view.DATA_DIR = '/mnt/data/stacks';
  view.LAN_IP = '192.168.1.10';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pod = (): any =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yaml.loadAll(Mustache.render(claudeDev.yamlContent, view)).find((d: any) => d?.kind === 'Pod');

  const sshEnv = (): Record<string, string> => {
    const c = pod().spec.containers.find((x: { name: string }) => x.name === 'claude-dev');
    const out: Record<string, string> = {};
    for (const e of c.env ?? []) out[e.name] = String(e.value);
    return out;
  };

  it('no longer runs hostNetwork', () => {
    // ADR 0007 Decision 1. claude-dev was never on the ADR's closed carve-out
    // list, so it is migrated rather than granted an exemption.
    expect(pod().spec.hostNetwork).toBeUndefined();
  });

  it('publishes sshd on the SAME port, on every interface — the lockout guard', () => {
    // This is the criterion an operator feels: their router port-forward and
    // `ssh -p 2222 …@<box>` must keep working with nothing changed on their
    // side. That needs hostPort == containerPort AND no `hostIP` (a
    // `hostIP: 127.0.0.1` pin like radicale's #2357 would make the box
    // reachable only from the box itself — i.e. lock the owner out).
    const c = pod().spec.containers.find((x: { name: string }) => x.name === 'claude-dev');
    expect(c.ports).toHaveLength(1);
    expect(c.ports[0].containerPort).toBe(2222);
    expect(c.ports[0].hostPort).toBe(2222);
    expect(c.ports[0].hostIP).toBeUndefined();
  });

  it('reaches LLDAP via host.containers.internal — never localhost or LAN_IP', () => {
    // An isolated pod cannot reach an on-box sibling on 127.0.0.1 (that is now
    // its OWN loopback), and rootless podman refuses the host's LAN IP
    // outright (ADR 0007 Context). host.containers.internal is the only path.
    expect(sshEnv().LLDAP_HOST).toBe('host.containers.internal');
    expect(sshEnv().LLDAP_HOST).not.toMatch(/localhost|127\.0\.0\.1|192\.168\./);
  });

  it('hard-codes the LLDAP host instead of taking the LLDAP_HOST variable', () => {
    // manifestAssembler force-resolves LLDAP_HOST to "localhost" for EVERY
    // template ("LLDAP_HOST is always localhost") — correct for the
    // hostNetwork `auth` pod that owns the variable, but it would silently
    // overwrite the value here and break every LDAP login with no error.
    expect(claudeDev.yamlContent).not.toMatch(/\{\{LLDAP_HOST\}\}/);
    expect(claudeDev.variables.LLDAP_HOST).toBeUndefined();
  });

  it('the sibling precondition it depends on is actually in place (ADR 0007 order)', () => {
    // "Siblings first, consumer second." The consumer above is only correct
    // because `auth` leaves LLDAP's raw LDAP port bound wider than loopback
    // and closes the LAN half at the host firewall instead (#2388). If a
    // future change loopback-binds that port, this consumer breaks — so pin
    // the precondition here, at the consumer, not only in the auth suite.
    expect(auth.yamlContent).not.toMatch(/name:\s*LLDAP_LDAP_HOST/);
    expect(auth.variables.LLDAP_LDAP_PORT.blockLanAccess).toBe(true);
  });

  it('is NOT added to ADR 0007 carve-out list', () => {
    // The list was closed in #2518/#2523. Migrating the consumer is the
    // decision; growing the list again would hollow that out.
    const adr = fs.readFileSync(
      path.join(__dirname, '..', '..', 'docs', 'adr',
        '0007-container-network-isolation-and-carveouts.md'), 'utf-8',
    );
    const decision2 = adr.slice(
      adr.indexOf('2. **These stay on `hostNetwork` deliberately'),
      adr.indexOf('3. **Consuming a loopback-bound sibling'),
    );
    expect(decision2.length).toBeGreaterThan(100);
    expect(decision2).not.toMatch(/claude-dev/);
  });

  it('schema-version is bumped to 2 with a CHANGELOG section and a v1-to-v2 migration', () => {
    expect(claudeDev.yamlContent).toMatch(/servicebay\.schema-version:\s*"2"/);
    const changelog = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'claude-dev', 'CHANGELOG.md'), 'utf-8',
    );
    expect(changelog).toMatch(/##\s*v2\b.*\(breaking\)/);
    const mig = fs.readFileSync(
      path.join(TEMPLATES_DIR, 'claude-dev', 'migrations', 'v1-to-v2.py'), 'utf-8',
    );
    // Structural hop — nothing on /workspace may be moved, renamed or deleted.
    expect(mig).not.toMatch(/shutil\.(move|rmtree)|os\.remove|\.unlink\(|\.rename\(/);
    expect(mig).toMatch(/untouched/i);
    // And it must never abort the deploy: a non-zero exit would leave the
    // operator unable to re-deploy their own dev box, while a broken LDAP
    // path does not lock anyone out (the local `dev` account still works).
    expect(mig).not.toMatch(/return\s+[1-9]|sys\.exit\([1-9]/);
  });
});

// ─── 3h. Mosquitto: the acceptance criteria of #2569, encoded ───────────────
//
// An MQTT broker is the one service on the box where a configuration slip is
// physical: whatever publishes to it may include a door lock, so "anyone on
// the LAN can connect" is not a data leak, it is an open remote control. Each
// `it` below pins one criterion from #2569 so a later edit cannot quietly undo
// it — the properties are all invisible in a green deploy.
describe('Mosquitto template: mandatory credentials, LAN reach, persistence (#2569)', () => {
  const mosquitto = templates.find(t => t.name === 'mosquitto')!;

  const view: Record<string, string> = {};
  for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
  for (const [name, meta] of Object.entries(mosquitto.variables)) {
    if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
      view[name] = meta.default;
    }
  }
  view.DATA_DIR = '/mnt/data';
  view.LAN_IP = '192.168.1.10';

  // `renderPodYaml` is the renderer the install path actually uses (#599 —
  // HTML escaping off, control chars escaped inside quoted scalars). Rendering
  // through it rather than raw Mustache is what makes the hostPath assertion
  // below meaningful: bare Mustache would escape the `/` in DATA_DIR.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pod = (): any =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yaml.loadAll(renderPodYaml(mosquitto.yamlContent, view)).find((d: any) => d?.kind === 'Pod');

  /** The shell body of the config-seeding initContainer — where the broker's
   *  mosquitto.conf and password file are actually produced. */
  const initScript = (): string => String(pod().spec.initContainers[0].args[0]);

  const readme = () => fs.readFileSync(path.join(TEMPLATES_DIR, 'mosquitto', 'README.md'), 'utf-8');

  it('runs in its own netns and is NOT added to the closed ADR 0007 carve-out list', () => {
    expect(pod().spec.hostNetwork).toBeUndefined();
    const adr = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'adr', '0007-container-network-isolation-and-carveouts.md'),
      'utf-8',
    );
    const decision2 = adr.slice(
      adr.indexOf('2. **These stay on `hostNetwork` deliberately'),
      adr.indexOf('3. **Consuming a loopback-bound sibling'),
    );
    expect(decision2.length).toBeGreaterThan(100);
    expect(decision2).not.toMatch(/mosquitto/);
  });

  it('publishes the MQTT port on EVERY interface — devices connect inward', () => {
    // The inverse of radicale's #2357 loopback pin, and deliberately so: a
    // lock/plug/sensor opens the TCP connection FROM the Wi-Fi, so a
    // `hostIP: 127.0.0.1` here would mean no device could ever connect while
    // the service still looked perfectly healthy.
    const c = pod().spec.containers.find((x: { name: string }) => x.name === 'mosquitto');
    expect(c.ports).toHaveLength(1);
    expect(c.ports[0].containerPort).toBe(1883);
    expect(c.ports[0].hostPort).toBe(1883);
    expect(c.ports[0].hostIP).toBeUndefined();
  });

  it('refuses anonymous clients and requires a password file', () => {
    const script = initScript();
    expect(script).toMatch(/^\s*allow_anonymous false$/m);
    expect(script).not.toMatch(/allow_anonymous\s+true/);
    expect(script).toMatch(/^\s*password_file \/mosquitto\/config\/passwd$/m);
    // The passwd file is generated by hashing the wizard's values — a
    // cleartext credential never lands on disk.
    expect(script).toMatch(/mosquitto_passwd -b -c \/mosquitto\/config\/passwd/);
  });

  it('fails the pod rather than starting an open broker when credentials are empty', () => {
    // Empty variables must not degrade into an anonymous broker. The
    // initContainer exits non-zero, so the pod never reaches a listening state.
    const script = initScript();
    expect(script).toMatch(/if \[ -z "\$MQTT_USERNAME" \] \|\| \[ -z "\$MQTT_PASSWORD" \]; then/);
    expect(script).toMatch(/exit 1/);
  });

  it('carries no literal credential — both are auto-generated secret variables', () => {
    for (const name of ['MQTT_USERNAME', 'MQTT_PASSWORD']) {
      expect(mosquitto.variables[name]?.type, `${name} must be type "secret"`).toBe('secret');
      // A non-empty default would ship the SAME credential to every install —
      // which is a committed literal by another name.
      expect(mosquitto.variables[name]?.default ?? '').toBe('');
      // …and `noAutoGenerate` would leave the value blank, i.e. no broker.
      expect(mosquitto.variables[name]?.noAutoGenerate).toBeFalsy();
    }
    // The manifest references them as placeholders only.
    expect(mosquitto.yamlContent).toMatch(/value: "\{\{MQTT_USERNAME\}\}"/);
    expect(mosquitto.yamlContent).toMatch(/value: "\{\{MQTT_PASSWORD\}\}"/);
  });

  it('generates both credentials device-safe — they are typed INTO devices (#2577)', () => {
    // Proven at a real device 2026-08-16: a Nuki lock was rejected
    // (`disconnected: not authorised`) with the generated 32-char value —
    // pasted, so complete — while Home Assistant took the same credentials;
    // a 24-char alphanumeric value connected on the first try. This template
    // exists so DEVICES can connect, so a credential a device cannot carry
    // defeats its entire purpose. The flag is what makes the assembler use
    // the shorter profile (manifestAssembler.ts); pinned here so a later
    // variables.json edit cannot quietly drop it.
    for (const name of ['MQTT_USERNAME', 'MQTT_PASSWORD']) {
      expect(mosquitto.variables[name]?.deviceSafe, `${name} must be deviceSafe`).toBe(true);
    }
  });

  it('keeps retained messages across a restart: persistence on, store on a host path', () => {
    // Retained messages ARE the device-state store. Without persistence every
    // reboot blanks them and Home Assistant shows `unknown` until each device
    // republishes — hours, for a battery device.
    const script = initScript();
    expect(script).toMatch(/^\s*persistence true$/m);
    expect(script).toMatch(/^\s*persistence_location \/mosquitto\/data\/$/m);

    const p = pod();
    const dataVol = p.spec.volumes.find((v: { name: string }) => v.name === 'mosquitto-data');
    expect(dataVol.hostPath?.path).toBe('/mnt/data/mosquitto/data');
    expect(dataVol.emptyDir).toBeUndefined();
    const c = p.spec.containers.find((x: { name: string }) => x.name === 'mosquitto');
    const mount = c.volumeMounts.find((m: { name: string }) => m.name === 'mosquitto-data');
    expect(mount.mountPath).toBe('/mosquitto/data');
    expect(mount.readOnly).toBeFalsy();
  });

  it('tells on-box consumers to use host.containers.internal, never a hardcoded IP', () => {
    // ADR 0007 Decision 3. Home Assistant is the first consumer; the README is
    // where an operator reads the address, so that is where the rule has to be
    // right. `localhost` from inside a container is that container.
    const doc = readme();
    expect(doc).toMatch(/host\.containers\.internal/);
    expect(doc).not.toMatch(/\{\{LAN_IP\}\}/);
    // No dotted-quad broker address anywhere in the instructions.
    expect(doc).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  it('ships no TLS listener, and the README states that consequence in plain words', () => {
    // The decision is "plain 1883 only" (consumer IoT firmware generally
    // cannot be given a private CA to trust). That is defensible ONLY while
    // the cost is stated where the operator will read it — so pin the README
    // text, not just the config.
    expect(initScript()).not.toMatch(/certfile|keyfile|cafile|listener\s+8883/);
    const doc = readme();
    expect(doc).toMatch(/does not use TLS/i);
    expect(doc).toMatch(/unencrypted|in the clear/i);
    expect(doc).toMatch(/do not reuse this password/i);
  });

  it('is offered by a stack so the wizard can install it', () => {
    const stack = fs.readFileSync(path.join(REPO_ROOT, 'stacks', 'home', 'README.md'), 'utf-8');
    expect(stack).toMatch(/^- \[x\] mosquitto —/m);
  });
});

// ─── 3i. Beets: the acceptance criteria of #2581, encoded ───────────────────
//
// beets shipped for three weeks as a local template that ran, looked healthy,
// and did literally nothing: no `command:` so the image default `beet web`
// ran, no ports at all so that UI answered only on a container-internal
// address, and PUID 1000 so it could not have written a tag even if an import
// had been triggered. Every one of those is invisible in a green deploy, which
// is exactly why they get assertions rather than a code comment.
describe('Beets template: reachable UI, in-place imports, no unattended rewrite (#2581)', () => {
  const beets = templates.find(t => t.name === 'beets')!;

  const view: Record<string, string> = {};
  for (const v of catalogVars) view[v] = `stub-${v.toLowerCase()}`;
  for (const [name, meta] of Object.entries(beets.variables)) {
    if (meta && typeof meta === 'object' && 'default' in meta && typeof meta.default === 'string') {
      view[name] = meta.default;
    }
  }
  view.DATA_DIR = '/mnt/data/stacks';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pod = (): any =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yaml.loadAll(renderPodYaml(beets.yamlContent, view)).find((d: any) => d?.kind === 'Pod');

  /** The shell body of the config-seeding initContainer. */
  const initScript = (): string => String(pod().spec.initContainers[0].args[0]);

  /** The beets config that initContainer writes, parsed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seededConfig = (): any => {
    const m = initScript().match(/<<'EOF'\n([\s\S]*?)\nEOF/);
    expect(m, 'seed-config initContainer must write a heredoc config').toBeTruthy();
    return yaml.load(m![1]);
  };

  const readme = () => fs.readFileSync(path.join(TEMPLATES_DIR, 'beets', 'README.md'), 'utf-8');

  it('publishes the web UI on the host — the #2581 "no ports at all" regression', () => {
    const c = pod().spec.containers.find((x: { name: string }) => x.name === 'beets');
    expect(c.ports, 'beets must declare a port; v1 declared none').toHaveLength(1);
    // The container side is pinned to 8337 because the seeded config's
    // `web.port` says 8337 — the two must agree or the hostPort forwards to
    // nothing. Only the host side is operator-configurable.
    expect(c.ports[0].containerPort).toBe(8337);
    expect(c.ports[0].hostPort).toBe(8337);
    // No `hostIP` pin: there is no reverse proxy in front, so a loopback-only
    // bind would reproduce the original "UI unreachable" symptom exactly.
    expect(c.ports[0].hostIP).toBeUndefined();
    expect(seededConfig().web.port).toBe(c.ports[0].containerPort);
    expect(seededConfig().web.host).toBe('0.0.0.0');
  });

  it('runs isolated and is NOT added to the closed ADR 0007 carve-out list', () => {
    expect(pod().spec.hostNetwork).toBeUndefined();
    const adr = fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'adr', '0007-container-network-isolation-and-carveouts.md'),
      'utf-8',
    );
    const decision2 = adr.slice(
      adr.indexOf('2. **These stay on `hostNetwork` deliberately'),
      adr.indexOf('3. **Consuming a loopback-bound sibling'),
    );
    expect(decision2.length).toBeGreaterThan(100);
    expect(decision2).not.toMatch(/beets/);
  });

  it('stays LAN-local: no subdomain, no SSO, because the UI has no login', () => {
    // `beet web` ships no authentication whatsoever, and it fronts a service
    // that can rewrite a music library — so it deliberately gets no public
    // hostname and therefore no nginx/auth dependency to register one with.
    const subdomainVars = Object.entries(beets.variables)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(([, meta]) => (meta as any)?.type === 'subdomain')
      .map(([name]) => name);
    expect(subdomainVars, 'beets must not expose a public subdomain').toEqual([]);
    const deps = String(pod().metadata.annotations['servicebay.dependencies'] ?? '');
    expect(deps).not.toMatch(/nginx|auth/);
    // The UI is a browser, not an editor — the one lever that limits what an
    // unauthenticated LAN request can do.
    expect(seededConfig().web.readonly).toBe(true);
    expect(readme()).toMatch(/no authentication/i);
  });

  it('never moves, copies or renames files on a fresh install', () => {
    // The criterion the whole unit turns on: an import writes tags into the
    // files where they already are. `move`/`copy` on would relocate and
    // rename the operator's entire collection.
    const cfg = seededConfig();
    expect(cfg.import.move, 'import.move must be off').toBe(false);
    expect(cfg.import.copy, 'import.copy must be off').toBe(false);
    expect(cfg.import.write, 'import.write is the point — tags in place').toBe(true);
    // A `paths:` scheme only takes effect when moving/copying; shipping one
    // would be a loaded gun for whoever flips move back on.
    expect(cfg.paths, 'no rename scheme may be seeded').toBeUndefined();
    // `-q` must skip what it cannot match confidently rather than guess.
    expect(cfg.import.quiet_fallback).toBe('skip');
  });

  it('never overwrites an existing config — it probes first', () => {
    const script = initScript();
    expect(script).toMatch(/if \[ -e \/config\/config\.yaml \]; then/);
    expect(script).toMatch(/exit 0/);
    // A companion `*.mustache` config would be re-rendered and written on
    // EVERY deploy, silently discarding an operator's hand-tuned beets
    // config (plugins, an AcoustID key). That is why there isn't one.
    expect(
      Object.keys(beets.configs),
      'beets must not ship a *.mustache config — it would clobber the operator config on redeploy',
    ).toEqual([]);
  });

  it('triggers no import on its own, and says so in plain language', () => {
    // Neither the pod nor its init script may invoke `beet import`. An
    // unattended import over somebody's music collection is a decision, not
    // a default — README.md carries the reasoning.
    // Comments may *mention* `beet import`; no line may RUN it. Strip
    // comments (both YAML's and the init script's are `#`-led) first.
    const executable = renderPodYaml(beets.yamlContent, view)
      .split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .join('\n');
    expect(executable).not.toMatch(/beet\s+import/);
    const doc = readme();
    expect(doc).toMatch(/Why nothing is imported automatically/);
    expect(doc).toMatch(/moves? and renames?/i);
    // …and it must still be operable: a documented one-line trigger.
    expect(doc).toMatch(/podman exec -it beets-beets beet import \/music/);
  });

  it('runs as container UID 0 so it can actually write to the music files', () => {
    // Under rootless podman, container UID 0 maps to the host podman user
    // that owns the file-share tree; UID 1000 (what v1 used) maps to a
    // sub-UID with no write access at all.
    const c = pod().spec.containers.find((x: { name: string }) => x.name === 'beets');
    expect(c.securityContext).toEqual({ runAsUser: 0, runAsGroup: 0 });
    const puid = c.env.find((e: { name: string }) => e.name === 'PUID');
    const pgid = c.env.find((e: { name: string }) => e.name === 'PGID');
    expect(puid.value).toBe('0');
    expect(pgid.value).toBe('0');
    // The initContainer writes into the same host-owned bind mount.
    expect(pod().spec.initContainers[0].securityContext).toEqual({ runAsUser: 0, runAsGroup: 0 });
    // /music must be writable — writing tags IS the job (unlike jellyfin's
    // read-only /media mount).
    const music = c.volumeMounts.find((v: { mountPath: string }) => v.mountPath === '/music');
    expect(music.readOnly).toBeUndefined();
  });

  it('keeps the volume paths the previous local install already used', () => {
    // The takeover is in-place: same service name, same host paths, so the
    // library database and the music stay exactly where they are.
    const byName = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pod().spec.volumes.map((v: any) => [v.name, v.hostPath.path]),
    );
    expect(byName['beets-config']).toBe('/mnt/data/stacks/beets/config');
    expect(byName['music-data']).toBe('/mnt/data/stacks/file-share/data/music');
    expect(byName['audiobooks-data']).toBe('/mnt/data/stacks/file-share/data/audiobooks');
  });

  it('ships schema-version 3 with a breaking v2 CHANGELOG entry and the v1→v2 migration', () => {
    expect(beets.yamlContent).toMatch(/servicebay\.schema-version:\s*"3"/);
    const changelog = fs.readFileSync(path.join(TEMPLATES_DIR, 'beets', 'CHANGELOG.md'), 'utf-8');
    // Breaking, so the wizard gates the deploy on an acknowledgement — the
    // right place for "this will touch your music" to reach a human.
    expect(changelog).toMatch(/^## v2 \(breaking\)$/m);
    // The two things the operator must actually do.
    expect(changelog).toMatch(/local-templates\/templates\/beets/);
    expect(changelog).toMatch(/move: no/);
    expect(
      fs.existsSync(path.join(TEMPLATES_DIR, 'beets', 'migrations', 'v1-to-v2.py')),
      'v2 needs its migration: the old /config is owned by a container sub-UID',
    ).toBe(true);
  });

  it('declares a healthcheck that proves the library opened, not just the process', () => {
    const hc = String(pod().metadata.annotations['servicebay.healthcheck']);
    expect(hc).toMatch(/\/stats/);
    // The stricter coverage probe is registered from post-deploy.py, NOT
    // here: this annotation gates install settleWait and a fresh install
    // legitimately has an empty library.
    const postDeploy = fs.readFileSync(path.join(TEMPLATES_DIR, 'beets', 'post-deploy.py'), 'utf-8');
    expect(postDeploy).toMatch(/beets-library-populated/);
  });

  // ── #2584: the coverage sidecar ──────────────────────────────────────
  //
  // The "library populated" check asserted `"items":[1-9]` on beets' /stats
  // and was therefore green on a 27k-file collection holding 485 items — the
  // exact state it was introduced to catch. A ratio needs a denominator that
  // is nowhere in that response, so the assertion moved into the pod. These
  // tests pin the parts of that arrangement that are invisible when it is
  // wrong: a green check.
  describe('library-coverage endpoint (#2584)', () => {
    const coverage = () =>
      pod().spec.containers.find((c: { name: string }) => c.name === 'coverage');
    const postDeploy = () =>
      fs.readFileSync(path.join(TEMPLATES_DIR, 'beets', 'post-deploy.py'), 'utf-8');

    it('the registered check is a status-code assertion against the sidecar, not a body regex', () => {
      const script = postDeploy();
      // The defect, spelled out: any regex over `{"albums":M,"items":N}` can
      // only assert "N ≥ something", and any constant put there ages into a
      // lie the moment the operator adds an album.
      expect(script).not.toMatch(/bodyMatch/);
      expect(script).toMatch(/BEETS_COVERAGE_PORT/);
      expect(script).toMatch(/\/coverage/);
      // The id is unchanged on purpose: the POST upserts by id, so an
      // already-installed box has its stale green row rewritten rather than
      // keeping it alongside a new one.
      expect(script).toMatch(/"id": "beets-library-populated"/);
    });

    it('runs in the beets pod, reads /music read-only, and counts what beets should have tagged', () => {
      const c = coverage();
      expect(c, 'the coverage container must exist').toBeTruthy();
      // Same image as beets — beets IS a Python app, so no second pull.
      expect(c.image).toBe(pod().spec.containers[0].image);
      const music = c.volumeMounts.find((v: { mountPath: string }) => v.mountPath === '/music');
      expect(music.name).toBe('music-data');
      expect(music.readOnly, 'the counter must never be able to write').toBe(true);
      // UID 0 for the same reason as the beets container: under rootless
      // podman anything else cannot even read the music tree.
      expect(c.securityContext).toEqual({ runAsUser: 0, runAsGroup: 0 });
    });

    it('is loopback-bound — the health poller is its only consumer', () => {
      const c = coverage();
      expect(c.ports).toHaveLength(1);
      expect(c.ports[0].containerPort).toBe(8338);
      expect(c.ports[0].hostPort).toBe(8338);
      // Unlike the UI port, this one is pinned to the host loopback: nothing
      // on the LAN has a reason to reach an endpoint that walks the music
      // tree (same reasoning as radicale's DAV port, #2357).
      expect(c.ports[0].hostIP).toBe('127.0.0.1');
      // …and it is declared, with the consumer-facing UI port still first
      // (readPrimaryTcpPort takes the head of this list).
      const ports = String(pod().metadata.annotations['servicebay.ports']);
      expect(ports).toBe('8337/tcp,8338/tcp');
    });

    it('holds the library to a PERCENTAGE floor, never a fixed item count', () => {
      // A count would have to be re-tuned every time the collection grows,
      // which is the failure mode #2584 is about. The behaviour of the
      // embedded script is exercised in tests/templates/test_post_deploy.py
      // (BeetsCoverageEndpoint); this asserts the knob is a ratio.
      const meta = beets.variables['BEETS_COVERAGE_MIN_PERCENT'] as { default?: string };
      expect(meta, 'the floor must be an operator-visible variable').toBeTruthy();
      expect(meta.default).toBe('90');
      const script = String(coverage().args[0]);
      expect(script).toMatch(/SB_COVERAGE_MIN_PERCENT/);
      expect(script).toMatch(/100\.0 \* items \/ files/);
    });

    it('the v2→v3 hop is informational — no data moves for a health-check change', () => {
      const mig = fs.readFileSync(
        path.join(TEMPLATES_DIR, 'beets', 'migrations', 'v2-to-v3.py'), 'utf-8',
      );
      // It exists only because the install runner refuses a deploy with a
      // gap in the migration chain (selectMigrationChain) — so it must not
      // touch anything.
      expect(mig).not.toMatch(/shutil\.(move|rmtree|copy)|os\.remove|\.unlink\(|\.rename\(|chown/);
      const changelog = fs.readFileSync(path.join(TEMPLATES_DIR, 'beets', 'CHANGELOG.md'), 'utf-8');
      expect(changelog).toMatch(/^## v3$/m);
      // The operator must be told the check will go red on an untagged
      // library — that is the fix landing, not a new fault.
      expect(changelog).toMatch(/red after this upgrade/i);
    });
  });

  it('is offered by a stack, unchecked — it rewrites files, so it is opt-in', () => {
    const stack = fs.readFileSync(path.join(REPO_ROOT, 'stacks', 'cloud', 'README.md'), 'utf-8');
    expect(stack).toMatch(/^- \[ \] beets —/m);
  });
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
describe('Mustache configs resolve to a real container mountPath', () => {
  // The presence of the `servicebay.config-mount` annotation when a template
  // ships *.mustache files is enforced by the strict manifest parser (#585) —
  // see the manifest-validation test above. This test handles the cross-
  // cutting piece the parser can't: the annotation value must match a real
  // mountPath somewhere in the rendered pod, otherwise the resolver has
  // nothing to write into.
  for (const t of templates) {
    if (Object.keys(t.configs).length === 0) continue;
    it(`${t.name}: servicebay.config-mount resolves to a real mountPath`, () => {
      // Render the YAML with a stub view so we can parse it. Strip
      // mustache section delimiters first ({{#FOO}}, {{/FOO}}, {{^FOO}})
      // so optional blocks survive parsing — the remaining variable
      // placeholders get a benign "0" stub.
      const safeYaml = t.yamlContent
        .replace(/\{\{[#/^][^}]+\}\}/g, '')
        .replace(/\{\{[^}]+\}\}/g, '0');
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
      // Annotation presence is enforced by the strict-manifest test above;
      // if it's missing here the other test will have already failed with
      // a better message, so just skip.
      if (!annot) return;

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
    // STACK_MIGRATIONS lives in serviceLifecycle.ts since the #589
    // split — ServiceManager.ts is now a facade that re-exports it.
    const sm = fs.readFileSync(path.join(BACKEND_SRC, 'lib', 'services', 'serviceLifecycle.ts'), 'utf-8');
    const block = sm.match(/STACK_MIGRATIONS:\s*Record<string,\s*string\[\]>\s*=\s*\{([\s\S]*?)\n\s*\};/);
    expect(block, 'STACK_MIGRATIONS block not found in serviceLifecycle.ts').toBeTruthy();

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
    'src/app/api/auth/oidc/route.ts',                                       // OIDC initiator — clientId comes from config
    'src/app/api/auth/oidc/callback/route.ts',                              // OIDC callback handler
    'src/app/api/system/authelia/oidc-clients/route.ts',                    // forwards client.client_id from input
    'packages/backend/src/lib/registry.ts',                                 // type definition
    'packages/backend/src/lib/capabilities/authelia.test.ts',               // unit tests use fixture meta to drive the handler
    'packages/backend/src/lib/capabilities/credentials.test.ts',            // unit tests use fixture meta to drive the handler
    'packages/backend/src/lib/capabilities/autheliaClientMerge.test.ts',    // unit tests use fixture client_id literals to drive the merge
    'packages/backend/src/lib/diagnose/probes/reconcileOidcClients.test.ts', // unit tests use fixture oidcClient meta to drive the reconcile action
    'packages/backend/src/lib/diagnose/ssoVerify.ts',                        // SSO probe maps each gated subdomain → its client_id + registered redirect to drive the real OIDC handshake (the value it TESTS, not a declaration)
    'packages/backend/src/lib/reverseProxy/autheliaRewrite.test.ts',         // unit tests use a fixture Authelia config's client_id literals to drive + assert the LAN->Public rewrite
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
    for (const file of [...walkSourceFiles(SRC_DIR), ...walkSourceFiles(BACKEND_SRC), ...walkSourceFiles(path.join(REPO_ROOT, 'packages', 'frontend', 'src'))]) {
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
  // genuinely need core knowledge — currently nginx's bootstrapNpmAdmin,
  // because it returns a tri-state result that drives the wizard's
  // credential-prompt UI (a script can't cleanly express that).
  //
  // Every other `isSelected('X')` is dead code or a regression in waiting.
  // This test fails if a new template name shows up in stackInstall/* —
  // forcing the author to either (a) extend post-deploy.py or (b) document
  // why their case can't live in a script and add it to ALLOWED below.
  const STACKINSTALL_DIR = path.join(BACKEND_SRC, 'lib', 'stackInstall');

  /** Map of file → set of template names allowed to appear in
   *  `isSelected(...)` calls. Anything else is a violation. */
  const ALLOWED: Record<string, Set<string>> = {
    'postInstall.ts': new Set([
      // bootstrapNpmAdmin returns a tri-state result that drives the
      // wizard's NPM-credentials-prompt UI when the auto-bootstrap
      // fails. A post-deploy.py script can't cleanly express that, so
      // the NPM bootstrap stays in the engine.
      'nginx',
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
  const EXPECTED_INFRA = new Set(['adguard', 'auth', 'nginx']);

  it('exactly the platform templates are tier=infrastructure', async () => {
    const { parseTemplateTier } = await import('@/lib/templateTier');
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

// ─── 5. Healthcheck contract (#626 + #628) ─────────────────────────────────
//
// Every template that another template lists in `servicebay.dependencies`
// must declare a `servicebay.healthcheck` annotation. Without it, downstream
// templates' install gate (settleWait → twin.health) has nothing to wait on
// and they race the upstream container. Templates with no downstream
// dependencies don't strictly need it for install gating but should declare
// one for ongoing monitoring (the CoreHealthBanner reads this).
describe('Healthcheck contract', () => {
  it('every dependency target declares servicebay.healthcheck', async () => {
    const { parseTemplateManifest } = await import('@/lib/template/contract');
    const manifests = new Map<string, ReturnType<typeof parseTemplateManifest>>();
    for (const t of templates) {
      manifests.set(t.name, parseTemplateManifest(t.yamlContent, {
        hasMustacheConfigs: Object.keys(t.configs).length > 0,
      }));
    }
    const dependedOn = new Set<string>();
    for (const [, result] of manifests) {
      if (!result.ok) continue;
      for (const dep of result.manifest.dependencies) dependedOn.add(dep);
    }
    const offenders: string[] = [];
    for (const target of dependedOn) {
      if (!templateNames.has(target)) continue; // separate test catches dangling deps
      const r = manifests.get(target);
      if (!r || !r.ok) continue; // manifest-validity test already flags this
      if (!r.manifest.healthcheckRaw) {
        const upstream = [...manifests.entries()]
          .filter(([, m]) => m.ok && m.manifest.dependencies.includes(target))
          .map(([n]) => n);
        offenders.push(`${target} (listed as a dependency by: ${upstream.join(', ')})`);
      }
    }
    expect(
      offenders,
      `Templates that other templates depend on but that declare no healthcheck:\n  ${offenders.join('\n  ')}\n\n` +
      `Add a \`servicebay.healthcheck\` annotation pointing at an HTTP endpoint (or TCP probe for non-HTTP services) so settleWait can gate on it.`,
    ).toEqual([]);
  });
});
