import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';

export async function GET() {
  try {
    const config = await getConfig();
    const hosts = config.reverseProxy?.hosts || [];

    // Find the LLDAP proxy host entry (created during deployment)
    const lldapHost = hosts.find(h => h.service === 'lldap' && h.created);
    if (lldapHost) {
      return NextResponse.json({ url: `https://${lldapHost.domain}` });
    }

    return NextResponse.json({ url: null });
  } catch {
    return NextResponse.json({ url: null });
  }
}
