import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const config = await getConfig();
        const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data';
        const confDir = `${dataDir}/nginx/conf.d`;

        const executor = getExecutor('Local');
        let files: string[];
        try {
            files = await executor.readdir(confDir);
        } catch {
            return NextResponse.json({ files: {} });
        }

        const confFiles = files.filter(f => f.endsWith('.conf'));
        const result: Record<string, string> = {};

        for (const file of confFiles) {
            try {
                result[file] = await executor.readFile(`${confDir}/${file}`);
            } catch {
                // skip unreadable files
            }
        }

        return NextResponse.json({ files: result });
    } catch (error) {
        console.error('Failed to export nginx config:', error);
        return NextResponse.json({ error: 'Failed to export nginx config' }, { status: 500 });
    }
}
