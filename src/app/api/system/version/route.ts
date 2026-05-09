import { NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';

let cached: { version: string; loadedAt: number } | null = null;

async function readVersion(): Promise<string> {
    try {
        const pkgPath = path.join(process.cwd(), 'package.json');
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

export async function GET() {
    if (!cached || Date.now() - cached.loadedAt > 60_000) {
        cached = { version: await readVersion(), loadedAt: Date.now() };
    }
    return NextResponse.json({ version: cached.version });
}
