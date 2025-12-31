import { NextResponse } from 'next/server';
import { getPodmanPs } from '@/lib/manager';

export async function GET() {
  const containers = await getPodmanPs();
  return NextResponse.json(containers);
}
