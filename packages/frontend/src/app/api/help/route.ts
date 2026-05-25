import { NextResponse } from 'next/server';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { withApiHandler } from '@/lib/api/handler';

const HELP_ALIASES: Record<string, string> = {
  containers: 'container-engine',
  volumes: 'container-engine',
};

const Query = z.object({ id: z.string().min(1) });

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    // Prevent directory traversal
    const safeId = query.id.replace(/[^a-zA-Z0-9-]/g, '');
    const normalizedId = HELP_ALIASES[safeId] ?? safeId;

    // Special-case: CHANGELOG.md lives at the project root (release-please
    // owns it). Serve it through this endpoint so the existing SectionHelp
    // modal can render it without a separate API surface.
    const filePath = normalizedId === 'changelog'
      ? path.join(process.cwd(), 'CHANGELOG.md')
      : path.join(process.cwd(), 'src/content/help', `${normalizedId}.md`);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ error: 'Help content not found' }, { status: 404 });
    }
  },
);
