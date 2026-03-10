import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';

export async function GET() {
  try {
    const config = await getConfig();
    return NextResponse.json({ enabled: !!config.oidc?.enabled });
  } catch {
    return NextResponse.json({ enabled: false });
  }
}
