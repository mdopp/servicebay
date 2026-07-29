/**
 * Root-free headless-Chromium provisioning for the agent sandbox (#2445).
 *
 * For a long time the autoloop treated "render the page in a real browser" as
 * unavailable here (#1930/#1473): `npx playwright install chromium` downloads
 * fine, but the binary dies on `libnspr4.so: cannot open shared object file`,
 * and `--with-deps` fails because it shells out to `su` (no root, no sudo).
 * Both blockers turn out to be fixable **without** root, and this script makes
 * that fix deterministic instead of a recipe someone re-derives each run
 * (CLAUDE.md: "deterministic execution → scripts; LLMs coordinate + evaluate").
 *
 * Two things are missing from the sandbox, neither of which needs privilege:
 *
 * 1. **Shared libraries.** `apt-get update` / `install --download-only` work
 *    with the state + cache dirs redirected into a writable dir and locking
 *    off; `dpkg-deb -x` unpacks each `.deb` into a local sysroot that
 *    `LD_LIBRARY_PATH` points at. The real `/var/lib/dpkg/status` is left in
 *    place on purpose, so apt resolves only the packages genuinely missing —
 *    notably it does NOT drag in `libc6`, which would put a second glibc ahead
 *    of the system one on the loader path.
 * 2. **Fonts.** With no fonts installed Chromium still lays the page out, but
 *    every text node measures **zero height** — so Playwright reports every
 *    text element as `hidden` and screenshots come back as empty boxes. That
 *    looks exactly like a CSS/visibility bug and burns real debugging time.
 *    Extracting `fonts-dejavu-core` and pointing `FONTCONFIG_FILE` at a
 *    generated `fonts.conf` fixes it. The verify step below asserts non-zero
 *    text height precisely so this failure can never be silent again.
 *
 * House pattern, sibling to scripts/check-lint-ratchet.ts and
 * scripts/autoloop-seal.ts — tsx, `node:` only, no new dependency. Playwright
 * itself is imported dynamically from the existing `@playwright/test`
 * devDependency, so the module stays importable (for `applyBrowserSandboxEnv`)
 * even where Playwright isn't installed.
 *
 *   tsx scripts/provision-browser-sandbox.ts [--check] [--force] [--print-env]
 *
 * --check      verify only; never touch the network or provision.
 * --force      re-provision even when the stamp says the sysroot is current.
 * --print-env  emit `export …` lines for `eval "$(…)"` in a shell that needs
 *              to launch the browser itself.
 *
 * Exit 0  a real page load rendered visible, non-zero-height text.
 * Exit 1  browser not available (provisioning or the render probe failed).
 * Exit 2  setup error (no Playwright, sandbox dir not writable).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The Debian packages Chromium's `chrome-headless-shell` links against that a
 * slim agent image omits, plus the font stack. Kept explicit rather than
 * derived from `ldd` output: apt resolves the transitive closure itself, and a
 * fixed list makes the stamp (and therefore idempotence) meaningful.
 *
 * `fonts-dejavu-core` is not a link-time dependency — it is what stops every
 * text node measuring zero height. Do not drop it "because the browser starts
 * without it": it starts, and then lies about visibility.
 */
export const SYSROOT_PACKAGES = [
    'libnss3',
    'libatk1.0-0',
    'libatk-bridge2.0-0',
    'libatspi2.0-0',
    'libdbus-1-3',
    'libx11-6',
    'libxcomposite1',
    'libxdamage1',
    'libxext6',
    'libxfixes3',
    'libxrandr2',
    'libgbm1',
    'libxcb1',
    'libxkbcommon0',
    'libasound2',
    'libcups2',
    'libpango-1.0-0',
    'libcairo2',
    'libdrm2',
    'libexpat1',
    'libglib2.0-0',
    'fonts-dejavu-core',
] as const;

/** Bumped when the layout of the sandbox dir changes, invalidating old stamps. */
const STAMP_VERSION = 1;

const CHECK_ONLY = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const PRINT_ENV = process.argv.includes('--print-env');

export interface Stamp {
    version: number;
    packages: string[];
    provisioned: string;
}

/**
 * Where the sysroot lives. Outside the repo on purpose — it is a machine-local
 * cache (~90 MB unpacked), not a build artifact, and must never be committed
 * or shipped in a Docker layer.
 */
export function sandboxDir(): string {
    return process.env.SB_BROWSER_SANDBOX_DIR ?? path.join(homedir(), '.cache', 'servicebay-browser-sandbox');
}

export interface SandboxPaths {
    root: string;
    sysroot: string;
    aptState: string;
    aptCache: string;
    archives: string;
    fontCache: string;
    fontsConf: string;
    stamp: string;
}

export function sandboxPaths(root = sandboxDir()): SandboxPaths {
    return {
        root,
        sysroot: path.join(root, 'sysroot'),
        aptState: path.join(root, 'apt', 'state'),
        aptCache: path.join(root, 'apt', 'cache'),
        archives: path.join(root, 'apt', 'cache', 'archives'),
        fontCache: path.join(root, 'fontcache'),
        fontsConf: path.join(root, 'fonts.conf'),
        stamp: path.join(root, 'stamp.json'),
    };
}

/**
 * The environment a process needs to launch the provisioned Chromium. Chrome
 * is spawned as a child of the Node process that calls `chromium.launch()`, so
 * mutating `process.env` in-process is enough — the loader path is read by the
 * child, not by us.
 */
export function browserEnv(
    root = sandboxDir(),
    base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
    const p = sandboxPaths(root);
    const libDirs = [
        path.join(p.sysroot, 'usr', 'lib', 'x86_64-linux-gnu'),
        path.join(p.sysroot, 'lib', 'x86_64-linux-gnu'),
    ];
    // Drop our own dirs from whatever is already on the path so calling this
    // twice (config import + the CLI, say) doesn't build up a duplicated
    // loader path.
    const existing = (base.LD_LIBRARY_PATH ?? '')
        .split(':')
        .filter((dir) => dir && !libDirs.includes(dir));
    return {
        LD_LIBRARY_PATH: [...libDirs, ...existing].join(':'),
        FONTCONFIG_FILE: p.fontsConf,
        FONTCONFIG_PATH: p.root,
    };
}

/**
 * Apply the sandbox env to this process when (and only when) the sysroot is
 * provisioned. A no-op elsewhere — on a machine with the system libraries
 * present, prepending a non-existent dir to `LD_LIBRARY_PATH` would be noise
 * at best. Safe to call at import time; that is how tests/e2e/playwright.config.ts
 * picks the sandbox up without every caller having to remember an `eval`.
 */
export function applyBrowserSandboxEnv(root = sandboxDir()): boolean {
    if (!isProvisioned(root)) return false;
    for (const [k, v] of Object.entries(browserEnv(root))) process.env[k] = v;
    return true;
}

/**
 * A generated fontconfig config. The extracted `fontconfig-config` package
 * ships one that points at `/etc/fonts/conf.d`, which does not exist here —
 * so generate a self-contained one instead of patching theirs. The generic
 * family aliases matter: a page asking for `sans-serif` with no mapping falls
 * back to no font at all, which is the zero-height failure again.
 */
export function renderFontsConf(root = sandboxDir()): string {
    const p = sandboxPaths(root);
    const alias = (generic: string, family: string) =>
        `  <match target="pattern">\n` +
        `    <test qual="any" name="family"><string>${generic}</string></test>\n` +
        `    <edit name="family" mode="prepend" binding="strong"><string>${family}</string></edit>\n` +
        `  </match>`;
    return [
        '<?xml version="1.0"?>',
        '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
        '<!-- Generated by scripts/provision-browser-sandbox.ts (#2445). Do not edit. -->',
        '<fontconfig>',
        `  <dir>${path.join(p.sysroot, 'usr', 'share', 'fonts')}</dir>`,
        `  <cachedir>${p.fontCache}</cachedir>`,
        alias('sans-serif', 'DejaVu Sans'),
        alias('sans', 'DejaVu Sans'),
        alias('serif', 'DejaVu Serif'),
        alias('monospace', 'DejaVu Sans Mono'),
        alias('system-ui', 'DejaVu Sans'),
        '</fontconfig>',
        '',
    ].join('\n');
}

export function readStamp(root = sandboxDir()): Stamp | null {
    const file = sandboxPaths(root).stamp;
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as Stamp;
    } catch {
        return null;
    }
}

/**
 * Idempotence check. The stamp alone isn't trusted — the fonts.conf and at
 * least one extracted library must actually be on disk, so a half-deleted
 * cache dir re-provisions instead of failing mysteriously at launch.
 */
export function isProvisioned(root = sandboxDir()): boolean {
    const stamp = readStamp(root);
    if (!stamp || stamp.version !== STAMP_VERSION) return false;
    if (stamp.packages.join(',') !== SYSROOT_PACKAGES.join(',')) return false;
    const p = sandboxPaths(root);
    if (!existsSync(p.fontsConf)) return false;
    return existsSync(path.join(p.sysroot, 'usr', 'lib', 'x86_64-linux-gnu', 'libnspr4.so'));
}

function log(msg: string): void {
    if (!PRINT_ENV) console.log(msg);
}

function run(cmd: string, args: string[], label: string): boolean {
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return true;
    log(`  ✗ ${label} failed (exit ${r.status ?? 'signal'})`);
    const detail = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(-6).join('\n  ');
    if (detail) log(`  ${detail}`);
    return false;
}

/** apt with every writable path redirected into the sandbox dir, locking off. */
function aptArgs(p: SandboxPaths): string[] {
    return [
        '-o', `Dir::State=${p.aptState}`,
        '-o', `Dir::State::Lists=${path.join(p.aptState, 'lists')}`,
        '-o', `Dir::Cache=${p.aptCache}`,
        '-o', `Dir::Cache::archives=${p.archives}`,
        '-o', 'Debug::NoLocking=1',
        '-o', 'APT::Get::Assume-Yes=true',
        '-o', 'APT::Install-Recommends=false',
        '-o', 'APT::Sandbox::User=root',
    ];
}

function provision(root: string): boolean {
    const p = sandboxPaths(root);
    log(`Provisioning browser sandbox in ${root}`);
    for (const dir of [
        path.join(p.aptState, 'lists', 'partial'),
        path.join(p.archives, 'partial'),
        p.sysroot,
        p.fontCache,
    ]) {
        mkdirSync(dir, { recursive: true });
    }

    log('  · apt-get update (redirected state/cache, no root)');
    if (!run('apt-get', [...aptArgs(p), 'update'], 'apt-get update')) return false;

    log(`  · downloading ${SYSROOT_PACKAGES.length} packages + their closure`);
    if (!run('apt-get', [...aptArgs(p), 'install', '--download-only', ...SYSROOT_PACKAGES], 'apt-get install --download-only')) {
        return false;
    }

    const debs = readdirSync(p.archives).filter((f) => f.endsWith('.deb'));
    if (debs.length === 0) {
        log('  ✗ apt downloaded no .deb files');
        return false;
    }
    log(`  · dpkg-deb -x ${debs.length} archives into the sysroot`);
    for (const deb of debs) {
        if (!run('dpkg-deb', ['-x', path.join(p.archives, deb), p.sysroot], `dpkg-deb -x ${deb}`)) return false;
    }

    writeFileSync(p.fontsConf, renderFontsConf(root));
    // A stale font cache from a previous layout makes fontconfig ignore the
    // new dir; cheap to rebuild, so always start clean.
    rmSync(p.fontCache, { recursive: true, force: true });
    mkdirSync(p.fontCache, { recursive: true });

    const stamp: Stamp = {
        version: STAMP_VERSION,
        packages: [...SYSROOT_PACKAGES],
        provisioned: new Date().toISOString(),
    };
    writeFileSync(p.stamp, `${JSON.stringify(stamp, null, 2)}\n`);
    log('  ✓ sysroot + fonts provisioned');
    return true;
}

/** The probe page. Deliberately plain: one heading, one paragraph, a web font
 *  stack that must resolve through fontconfig, and a known font-size so a
 *  correct render has a predictable minimum height. */
const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ServiceBay browser probe</title>
<style>body{font-family:sans-serif;margin:0}#probe{font-size:32px;line-height:1.2}</style>
</head><body>
<h1 id="probe">ServiceBay headless render probe</h1>
<p id="probe-body">If this text has non-zero height, fonts and libraries are wired.</p>
</body></html>`;

interface ProbeResult {
    ok: boolean;
    detail: string;
    height?: number;
    visible?: boolean;
}

/**
 * The actual acceptance test: serve the probe over real HTTP on loopback, load
 * it with Playwright, and assert the heading is *visible with non-zero height*.
 * `setContent` would be cheaper, but a `goto` also proves the browser's network
 * stack works — which is what an e2e spec against the box will need.
 */
async function probeBrowser(): Promise<ProbeResult> {
    let chromium: typeof import('@playwright/test').chromium;
    try {
        ({ chromium } = await import('@playwright/test'));
    } catch {
        return { ok: false, detail: '@playwright/test is not installed (npm ci first)' };
    }

    if (!existsSync(chromium.executablePath())) {
        if (CHECK_ONLY) return { ok: false, detail: 'chromium binary missing (run without --check to install)' };
        log('  · chromium binary missing — npx playwright install chromium');
        if (!run('npx', ['playwright', 'install', 'chromium'], 'playwright install chromium')) {
            return { ok: false, detail: 'playwright install chromium failed' };
        }
    }

    const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PROBE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30_000 });
            const heading = page.locator('#probe');
            const visible = await heading.isVisible();
            const box = await heading.boundingBox();
            const height = box?.height ?? 0;
            if (!visible || height <= 0) {
                return {
                    ok: false,
                    visible,
                    height,
                    detail:
                        'text rendered with zero height — fontconfig is not resolving a family ' +
                        '(the classic "looks like a CSS bug" symptom, see the header of this script)',
                };
            }
            return { ok: true, visible, height, detail: `heading rendered ${height}px tall` };
        } finally {
            await browser.close();
        }
    } catch (err) {
        return { ok: false, detail: `launch/navigate failed: ${(err as Error).message.split('\n')[0]}` };
    } finally {
        server.close();
    }
}

async function main(): Promise<void> {
    const root = sandboxDir();

    if (!CHECK_ONLY && (FORCE || !isProvisioned(root))) {
        if (!provision(root)) {
            emit({ available: false, sandboxDir: root, detail: 'provisioning failed' });
            process.exit(1);
        }
    } else if (isProvisioned(root)) {
        log(`Browser sandbox already provisioned in ${root} (stamp current)`);
    } else {
        log(`Browser sandbox not provisioned in ${root} (--check: not provisioning)`);
    }

    applyBrowserSandboxEnv(root);

    const probe = await probeBrowser();
    if (!probe.ok) {
        log(`✗ headless browser NOT available: ${probe.detail}`);
        emit({ available: false, sandboxDir: root, detail: probe.detail, height: probe.height });
        process.exit(1);
    }

    log(`✓ headless browser available — ${probe.detail}`);
    if (PRINT_ENV) {
        for (const [k, v] of Object.entries(browserEnv(root))) console.log(`export ${k}=${JSON.stringify(v)}`);
    }
    emit({ available: true, sandboxDir: root, detail: probe.detail, height: probe.height });
}

/**
 * Machine-readable last line, mirroring scripts/autoloop-seal.ts's contract.
 * Goes to stderr under `--print-env` so `eval "$(…)"` only ever sees `export`
 * lines.
 */
function emit(result: Record<string, unknown>): void {
    const line = `BROWSER_SANDBOX_RESULT ${JSON.stringify(result)}`;
    if (PRINT_ENV) console.error(line);
    else console.log(line);
}

// Only run when invoked directly, so playwright.config.ts (and the tests) can
// import applyBrowserSandboxEnv without provisioning anything.
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('provision-browser-sandbox.ts') || invokedPath.endsWith('provision-browser-sandbox.js')) {
    void main();
}
