import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { findNginxConfDir } from '@/lib/nginx/confDir';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const nodeParam = searchParams.get('node');

        const result = await findNginxConfDir();
        const debug = result?.debug || ['findNginxConfDir returned null'];
        const nodeName = nodeParam || result?.nodeName || 'Local';
        const confDir = result?.confDir;

        if (!confDir) {
            return NextResponse.json({
                files: {},
                node: nodeName,
                reason: 'Could not resolve nginx conf.d path',
                debug
            });
        }

        const executor = getExecutor(nodeName);
        let allFiles: string[];
        try {
            allFiles = await executor.readdir(confDir);
        } catch (e) {
            return NextResponse.json({
                files: {},
                node: nodeName,
                confDir,
                reason: `Cannot read directory ${confDir}: ${e}`,
                debug
            });
        }

        const confFiles = allFiles.filter(f => f.endsWith('.conf'));
        if (confFiles.length === 0) {
            return NextResponse.json({
                files: {},
                node: nodeName,
                confDir,
                reason: `Directory ${confDir} has ${allFiles.length} file(s) but none ending in .conf: [${allFiles.join(', ')}]`,
                debug
            });
        }

        const fileContents: Record<string, string> = {};
        for (const file of confFiles) {
            try {
                fileContents[file] = await executor.readFile(`${confDir}/${file}`);
            } catch {
                // skip unreadable files
            }
        }

        return NextResponse.json({ files: fileContents, node: nodeName, confDir });
    } catch (error) {
        console.error('Failed to export nginx config:', error);
        return NextResponse.json({ error: 'Failed to export nginx config' }, { status: 500 });
    }
}
