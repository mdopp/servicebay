import { NextResponse } from 'next/server';
import { discoverSystemdServices } from '@/lib/discovery';

export const dynamic = 'force-dynamic';

export async function GET() {
  const services = await discoverSystemdServices();
  return NextResponse.json(services);
}
