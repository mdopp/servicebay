/**
 * Cross-scope dependency lint for `install-fedora-coreos.sh` (#586).
 *
 * The butane template embeds units in two systemd instances:
 *   - user-scope  : /var/home/<user>/.config/{containers/systemd,systemd/user}/*
 *   - system-scope: /etc/systemd/system/*
 *
 * systemd cannot resolve dependency directives across scopes by name:
 *   - a user unit's `Requires=foo.service` only searches user paths; a
 *     system unit named `foo.service` is invisible
 *   - a system unit cannot see user units either
 *
 * #586 was a fresh-boot showstopper of exactly this shape:
 *   servicebay.container (user) declared
 *     Requires=servicebay-auth-secret-init.service
 *   but the target lived in /etc/systemd/system/. User systemd refused to
 *   start with "Unit servicebay-auth-secret-init.service not found" and
 *   the server never bound its port.
 *
 * This test parses the butane heredoc out of the install script,
 * classifies every declared unit by scope, and asserts no dep in a unit's
 * `[Unit]` section references a unit declared in the opposite scope.
 *
 * Units NOT declared in the butane (OS-provided targets like
 * `network-online.target`, auto-generated mount units like
 * `var-mnt-data.mount`, etc.) are ignored — we only flag the case where
 * the install script itself declares both ends of the broken link.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'install-fedora-coreos.sh');

const DEP_DIRECTIVES = [
  'After', 'Before', 'Requires', 'Requisite', 'Wants', 'BindsTo', 'PartOf', 'Conflicts',
] as const;

type Scope = 'user' | 'system';

interface ButaneFile {
  path: string;
  contents?: { inline?: string };
  target?: string;
}

interface DeclaredUnit {
  /** Butane storage.files path (with `${VAR}` placeholders intact). */
  path: string;
  /** Unit name as systemd would see it (basename, with `.container` → `.service`). */
  unitName: string;
  scope: Scope;
  /** Lines of the unit body (only present for `contents.inline` declarations, not symlinks). */
  body?: string;
}

function extractButaneTemplate(script: string): string {
  // The template is written by a single heredoc:
  //   cat <<'EOF' > "$TEMPLATE"
  //   ...
  //   EOF
  const startRe = /^cat\s+<<'EOF'\s+>\s+"\$TEMPLATE"\s*$/m;
  const startMatch = script.match(startRe);
  if (!startMatch || startMatch.index === undefined) {
    throw new Error('Could not locate butane heredoc start (cat <<\'EOF\' > "$TEMPLATE")');
  }
  const afterStart = script.slice(startMatch.index + startMatch[0].length).replace(/^\n/, '');
  const endMatch = afterStart.match(/^EOF$/m);
  if (!endMatch || endMatch.index === undefined) {
    throw new Error('Could not locate butane heredoc EOF terminator');
  }
  return afterStart.slice(0, endMatch.index);
}

/** Map a butane file path to systemd scope, or null if it's not a unit declaration. */
function classifyUnitPath(p: string): Scope | null {
  // User Quadlet (.container → user .service)
  if (/^\/var\/home\/[^/]+\/\.config\/containers\/systemd\/[^/]+\.(container|kube|network|volume|pod)$/.test(p)) {
    return 'user';
  }
  // User systemd unit file
  if (/^\/var\/home\/[^/]+\/\.config\/systemd\/user\/[^/]+\.(service|socket|timer|target|mount|path)$/.test(p)) {
    return 'user';
  }
  // System unit file
  if (/^\/etc\/systemd\/system\/[^/]+\.(service|socket|timer|target|mount|path)$/.test(p)) {
    return 'system';
  }
  return null;
}

/** Translate a butane file path to the unit name systemd resolves at runtime. */
function unitNameFromPath(p: string): string {
  const base = path.basename(p);
  // Quadlet generators: foo.container → foo.service, foo.kube → foo.service.
  // Quadlet pods/volumes/networks are also reachable via foo-pod.service etc.,
  // but the simple stem rule is enough for the units this installer ships.
  if (base.endsWith('.container') || base.endsWith('.kube')) {
    return base.replace(/\.(container|kube)$/, '.service');
  }
  return base;
}

/** Extract dependency directive values from a unit body's `[Unit]` section. */
function depsFromUnitBody(body: string): Map<string, { directive: string; line: number }[]> {
  const result = new Map<string, { directive: string; line: number }[]>();
  const lines = body.split('\n');
  let inUnit = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inUnit = trimmed === '[Unit]';
      continue;
    }
    if (!inUnit) continue;
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(DEP_DIRECTIVES as readonly string[]).includes(key)) continue;
    // Multiple deps per line are whitespace-separated; same directive can
    // appear on multiple lines (systemd merges them additively).
    for (const dep of val.split(/\s+/).filter(Boolean)) {
      if (!result.has(dep)) result.set(dep, []);
      result.get(dep)!.push({ directive: key, line: i + 1 });
    }
  }
  return result;
}

function loadDeclaredUnits(): DeclaredUnit[] {
  const script = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
  let template = extractButaneTemplate(script);
  // Three placeholders (`${SERVICEBAY_CONFIG_JSON}`, `${SERVICEBAY_SSH_PRIV}`,
  // `${SERVICEBAY_SSH_PUB}` in some contexts) are injected at column 0 and
  // expand to multi-line content via envsubst at render time. Raw, they break
  // the YAML block-scalar parser. We don't care about their contents (they
  // aren't units) — replace each lone-line placeholder with a single indented
  // stub string so the rest of the document parses.
  template = template.replace(/^\$\{[A-Z_]+\}[ \t]*$/gm, '          "STUBBED_INTERPOLATION"');
  const parsed = yaml.load(template) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Butane template did not parse to an object');
  }
  const storage = parsed.storage as { files?: ButaneFile[] } | undefined;
  const files = storage?.files ?? [];

  const units: DeclaredUnit[] = [];
  for (const file of files) {
    if (!file.path) continue;
    const scope = classifyUnitPath(file.path);
    if (!scope) continue;
    // Skip enable-symlinks (`target:` instead of `contents.inline`). We only
    // care about the actual unit declarations; symlinks just turn enabled-by-
    // default on for an already-declared unit.
    const body = file.contents?.inline;
    units.push({
      path: file.path,
      unitName: unitNameFromPath(file.path),
      scope,
      body,
    });
  }
  return units;
}

describe('install-fedora-coreos.sh: cross-scope systemd dependencies', () => {
  it('user-scope units do not declare dependencies on system-scope units (#586)', () => {
    const units = loadDeclaredUnits();
    const systemUnitNames = new Set(
      units.filter(u => u.scope === 'system').map(u => u.unitName),
    );
    const violations: string[] = [];

    for (const unit of units) {
      if (unit.scope !== 'user' || !unit.body) continue;
      const deps = depsFromUnitBody(unit.body);
      for (const [dep, refs] of deps) {
        if (systemUnitNames.has(dep)) {
          for (const ref of refs) {
            violations.push(
              `${unit.path} (line ${ref.line}): ${ref.directive}=${dep} ` +
              `— '${dep}' is a system-scope unit declared in the same butane; ` +
              `user systemd cannot resolve it (see #586)`,
            );
          }
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('system-scope units do not declare dependencies on user-scope units', () => {
    const units = loadDeclaredUnits();
    const userUnitNames = new Set(
      units.filter(u => u.scope === 'user').map(u => u.unitName),
    );
    const violations: string[] = [];

    for (const unit of units) {
      if (unit.scope !== 'system' || !unit.body) continue;
      const deps = depsFromUnitBody(unit.body);
      for (const [dep, refs] of deps) {
        if (userUnitNames.has(dep)) {
          for (const ref of refs) {
            violations.push(
              `${unit.path} (line ${ref.line}): ${ref.directive}=${dep} ` +
              `— '${dep}' is a user-scope unit declared in the same butane; ` +
              `system systemd cannot resolve it`,
            );
          }
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('parses every declared unit (smoke check so a refactor that breaks the lint surfaces here)', () => {
    const units = loadDeclaredUnits();
    // The current installer ships at least: servicebay.container,
    // install-nginx.service (user); servicebay-auth-secret-init.service,
    // setup-config-merge.service (system). If this drops below 2 of each
    // the parser probably broke.
    expect(units.filter(u => u.scope === 'user').length).toBeGreaterThanOrEqual(2);
    expect(units.filter(u => u.scope === 'system').length).toBeGreaterThanOrEqual(2);
  });
});
