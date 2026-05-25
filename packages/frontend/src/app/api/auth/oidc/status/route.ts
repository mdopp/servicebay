import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

export const GET = withApiHandler({}, async () => {
  try {
    const config = await getConfig();
    return NextResponse.json({ enabled: !!config.oidc?.enabled });
  } catch {
    return NextResponse.json({ enabled: false });
  }
});
