import { NextResponse } from 'next/server';
import { getServiceStatus } from '@/lib/manager';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  
  try {
    const status = await getServiceStatus(name);
    return NextResponse.json({ status });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
