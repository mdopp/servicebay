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
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
