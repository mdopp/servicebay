import { NextResponse } from 'next/server';
import { getAllSystemServices } from '@/lib/manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const services = await getAllSystemServices();
    return NextResponse.json(services);
  } catch (error) {
    console.error('Failed to fetch system services:', error);
    return NextResponse.json({ error: 'Failed to fetch system services' }, { status: 500 });
  }
}
