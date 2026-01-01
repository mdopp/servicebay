import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'ID is required' }, { status: 400 });
  }

  // Prevent directory traversal
  const safeId = id.replace(/[^a-zA-Z0-9-]/g, '');
  const filePath = path.join(process.cwd(), 'src/content/help', `${safeId}.md`);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return NextResponse.json({ content });
  } catch {
    return NextResponse.json({ error: 'Help content not found' }, { status: 404 });
  }
}
