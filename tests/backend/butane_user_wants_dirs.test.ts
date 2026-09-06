/**
 * Every `links:` parent under `~${HOST_USER}` must be a declared, user-owned
 * directory in `fedora-coreos.bu` (#2850).
 *
 * The bug this locks down: Ignition happily creates a link's *missing* parent
 * directories, but it creates them as `root:root` — the `user:`/`group:` on the
 * link entry applies to the symlink, not to the directories conjured on the way
 * to it. So `.../systemd/user/default.target.wants/`, which only ever existed
 * because two links pointed into it, came out
 * `drwxr-xr-x root root` on the box while every other directory in the chain
 * (`~/.config`, `~/.config/systemd`, `~/.config/systemd/user`) was `core:core`,
 * because those three ARE declared under `storage.directories`.
 *
 * The blast radius is not first boot — `install-nginx.service` and
 * `servicebay-trigger.path` are written by Ignition itself, as root, and work
 * fine. It is every *later* user unit: a template's post-deploy running
 * `systemctl --user enable --now <unit>` for a `WantedBy=default.target` unit
 * gets `Failed to enable unit: Access denied` (D-Bus `AccessDenied`, "Permission
 * denied" on the wants directory), the unit stays disabled, and the post-deploy
 * usually reports success anyway.
 *
 * So the invariant is structural, not per-unit: declare the parent, or the next
 * user-scope wants/ directory someone adds a link into repeats this silently.
 * `/etc/...` link parents are deliberately NOT covered — those wants/
 * directories are root-owned by design and root is the only writer.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUTANE_TEMPLATE = path.join(
  REPO_ROOT, 'tools', 'sb', 'internal', 'build', 'assets', 'fedora-coreos.bu',
);

const HOST_HOME = '/var/home/${HOST_USER}';
const USER_WANTS_DIR = `${HOST_HOME}/.config/systemd/user/default.target.wants`;

interface ButaneOwner { name?: string }
interface ButaneEntry {
  path: string;
  mode?: number;
  target?: string;
  user?: ButaneOwner;
  group?: ButaneOwner;
}

const RAW = fs.readFileSync(BUTANE_TEMPLATE, 'utf8');

/** Parse the raw Butane asset (same stub trick as install_nvidia_cdi_timer.test.ts). */
function butaneStorage(): { directories: ButaneEntry[]; links: ButaneEntry[] } {
  // Column-0 `${VAR}` placeholders expand to multi-line content at render time
  // and break the block-scalar parser raw.
  const template = RAW.replace(/^\$\{[A-Z_]+\}[ \t]*$/gm, '          "STUBBED_INTERPOLATION"');
  const parsed = yaml.load(template) as {
    storage?: { directories?: ButaneEntry[]; links?: ButaneEntry[] };
  } | null;
  return {
    directories: parsed?.storage?.directories ?? [],
    links: parsed?.storage?.links ?? [],
  };
}

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));

describe('fedora-coreos.bu: user-home link parents are declared directories (#2850)', () => {
  const { directories, links } = butaneStorage();
  const byPath = new Map(directories.map((d) => [d.path, d]));
  const userLinks = links.filter((l) => l.path.startsWith(`${HOST_HOME}/`));

  it('finds the user-home links at all (guards the parser, not the asset)', () => {
    // If the stub/parse trick ever breaks, every assertion below would pass
    // vacuously over an empty list.
    expect(userLinks.length).toBeGreaterThanOrEqual(3);
  });

  it.each(userLinks.map((l) => [l.path] as const))(
    'the parent of %s is declared and owned by ${HOST_USER}',
    (linkPath) => {
      const parent = parentOf(linkPath);
      const dir = byPath.get(parent);
      expect(
        dir,
        `${parent} is not in storage.directories — Ignition would create it as root:root, `
        + 'and the host user could never enable another unit into it (#2850)',
      ).toBeDefined();
      expect(dir?.user?.name).toBe('${HOST_USER}');
      expect(dir?.group?.name).toBe('${HOST_USER}');
    },
  );

  it('declares default.target.wants — the directory that was root:root on the box', () => {
    const dir = byPath.get(USER_WANTS_DIR);
    expect(dir).toBeDefined();
    // js-yaml reads the literal `0755` as decimal 755 (YAML 1.2 has no octal
    // leading-zero form); Butane reads the same literal as octal 0755. Pin both
    // the parsed value and the leading zero the renderer depends on.
    expect(dir?.mode).toBe(755);
    expect(RAW).toContain(`- path: ${USER_WANTS_DIR}\n      mode: 0755\n`);
  });

  it('every user-home link still carries its own user/group', () => {
    for (const link of userLinks) {
      expect(link.user?.name, `${link.path} link user`).toBe('${HOST_USER}');
      expect(link.group?.name, `${link.path} link group`).toBe('${HOST_USER}');
    }
  });
});
