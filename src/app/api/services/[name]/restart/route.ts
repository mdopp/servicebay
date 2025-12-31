import { NextResponse } from 'next/server';
import { updateAndRestartService } from '@/lib/manager';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  
  try {
    const result = await updateAndRestartService(name);
    return NextResponse.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
