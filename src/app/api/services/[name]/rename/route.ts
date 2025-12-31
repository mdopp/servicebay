
import { NextRequest, NextResponse } from 'next/server';
import { renameService } from '@/lib/manager';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  try {
    const body = await request.json();
    const { newName } = body;

    if (!newName) {
      return NextResponse.json({ error: 'New name is required' }, { status: 400 });
    }

    await renameService(name, newName);
    return NextResponse.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
