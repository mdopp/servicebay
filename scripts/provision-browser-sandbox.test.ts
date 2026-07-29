import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    SYSROOT_PACKAGES,
    browserEnv,
    applyBrowserSandboxEnv,
    isProvisioned,
    readStamp,
    renderFontsConf,
    sandboxPaths,
} from './provision-browser-sandbox';

/** Build a sandbox dir that looks provisioned, the way the script leaves it. */
function fakeProvisioned(packages: readonly string[] = SYSROOT_PACKAGES, version = 1): string {
    const root = mkdtempSync(path.join(tmpdir(), 'sb-browser-sandbox-'));
    const p = sandboxPaths(root);
    mkdirSync(path.join(p.sysroot, 'usr', 'lib', 'x86_64-linux-gnu'), { recursive: true });
    writeFileSync(path.join(p.sysroot, 'usr', 'lib', 'x86_64-linux-gnu', 'libnspr4.so'), '');
    writeFileSync(p.fontsConf, renderFontsConf(root));
    writeFileSync(p.stamp, JSON.stringify({ version, packages, provisioned: new Date().toISOString() }));
    return root;
}

const created: string[] = [];
function sandbox(...args: Parameters<typeof fakeProvisioned>): string {
    const root = fakeProvisioned(...args);
    created.push(root);
    return root;
}

afterEach(() => {
    while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('SYSROOT_PACKAGES', () => {
    it('carries the fonts package — without it every text node measures zero height (#2445)', () => {
        expect(SYSROOT_PACKAGES).toContain('fonts-dejavu-core');
    });

    it('carries the library that actually blocked launch, and NOT libc6', () => {
        expect(SYSROOT_PACKAGES).toContain('libnss3'); // pulls libnspr4 transitively
        // A second glibc ahead of the system one on LD_LIBRARY_PATH breaks
        // every child process, not just chromium.
        expect(SYSROOT_PACKAGES).not.toContain('libc6');
    });
});

describe('browserEnv', () => {
    it('points the loader at both sysroot lib dirs and fontconfig at the generated conf', () => {
        const env = browserEnv('/sb', {});
        expect(env.LD_LIBRARY_PATH).toBe('/sb/sysroot/usr/lib/x86_64-linux-gnu:/sb/sysroot/lib/x86_64-linux-gnu');
        expect(env.FONTCONFIG_FILE).toBe('/sb/fonts.conf');
        expect(env.FONTCONFIG_PATH).toBe('/sb');
    });

    it('prepends to an existing LD_LIBRARY_PATH without dropping it', () => {
        const env = browserEnv('/sb', { LD_LIBRARY_PATH: '/opt/foo' });
        expect(env.LD_LIBRARY_PATH.endsWith(':/opt/foo')).toBe(true);
    });

    it('is idempotent — applying twice does not duplicate the loader path', () => {
        const once = browserEnv('/sb', {});
        const twice = browserEnv('/sb', { LD_LIBRARY_PATH: once.LD_LIBRARY_PATH });
        expect(twice.LD_LIBRARY_PATH).toBe(once.LD_LIBRARY_PATH);
    });
});

describe('renderFontsConf', () => {
    it('maps the generic families a page asks for onto DejaVu', () => {
        const conf = renderFontsConf('/sb');
        for (const generic of ['sans-serif', 'serif', 'monospace']) {
            expect(conf).toContain(`<string>${generic}</string>`);
        }
        expect(conf).toContain('DejaVu Sans');
    });

    it('points at the sysroot font dir and a writable cache dir', () => {
        const conf = renderFontsConf('/sb');
        expect(conf).toContain('<dir>/sb/sysroot/usr/share/fonts</dir>');
        expect(conf).toContain('<cachedir>/sb/fontcache</cachedir>');
    });
});

describe('isProvisioned', () => {
    it('is true for a complete sandbox dir', () => {
        expect(isProvisioned(sandbox())).toBe(true);
    });

    it('is false when the sandbox dir does not exist at all', () => {
        expect(isProvisioned(path.join(tmpdir(), 'sb-browser-sandbox-absent'))).toBe(false);
    });

    it('re-provisions when the package list changed', () => {
        expect(isProvisioned(sandbox(['libnss3']))).toBe(false);
    });

    it('re-provisions when the stamp layout version is stale', () => {
        expect(isProvisioned(sandbox(SYSROOT_PACKAGES, 0))).toBe(false);
    });

    it('re-provisions when the stamp survives but the extracted libs were cleared', () => {
        const root = sandbox();
        rmSync(sandboxPaths(root).sysroot, { recursive: true, force: true });
        expect(isProvisioned(root)).toBe(false);
    });

    it('re-provisions when fonts.conf is missing — the zero-height trap', () => {
        const root = sandbox();
        rmSync(sandboxPaths(root).fontsConf, { force: true });
        expect(isProvisioned(root)).toBe(false);
    });

    it('tolerates a corrupt stamp instead of throwing', () => {
        const root = sandbox();
        writeFileSync(sandboxPaths(root).stamp, 'not json');
        expect(readStamp(root)).toBeNull();
        expect(isProvisioned(root)).toBe(false);
    });
});

describe('applyBrowserSandboxEnv', () => {
    it('mutates process.env and reports true when provisioned', () => {
        const root = sandbox();
        const before = process.env.FONTCONFIG_FILE;
        try {
            expect(applyBrowserSandboxEnv(root)).toBe(true);
            expect(process.env.FONTCONFIG_FILE).toBe(sandboxPaths(root).fontsConf);
        } finally {
            if (before === undefined) delete process.env.FONTCONFIG_FILE;
            else process.env.FONTCONFIG_FILE = before;
            delete process.env.LD_LIBRARY_PATH;
            delete process.env.FONTCONFIG_PATH;
        }
    });

    it('is a safe no-op on a machine with no sandbox dir', () => {
        const before = { ...process.env };
        expect(applyBrowserSandboxEnv(path.join(tmpdir(), 'sb-browser-sandbox-absent'))).toBe(false);
        expect(process.env.FONTCONFIG_FILE).toBe(before.FONTCONFIG_FILE);
    });
});
