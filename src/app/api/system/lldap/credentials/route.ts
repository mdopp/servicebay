import { NextResponse } from 'next/server';
import { getConfig, saveConfig, updateConfig } from '@/lib/config';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * Read whether LLDAP admin credentials are stored. Never returns the password
 * itself — only `configured: boolean`, the URL, and the username.
 */
export async function GET() {
  const config = await getConfig();
  const lldap = config.lldap;
  return NextResponse.json({
    configured: Boolean(lldap?.password),
    url: lldap?.url ?? '',
    username: lldap?.username ?? '',
  });
}

/**
 * Save LLDAP admin credentials. Body: `{ url, username, password }`. Used by
 * the onboarding wizard right after the lldap stack is deployed so the user
 * can later retrieve the auto-generated admin password from Settings.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { url, username, password } = body as {
      url?: string;
      username?: string;
      password?: string;
    };

    if (typeof url !== 'string' || !url || typeof password !== 'string' || !password) {
      return NextResponse.json({ error: 'url and password are required' }, { status: 400 });
    }

    await updateConfig({
      lldap: { url, username: username || 'admin', password },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, { tag: 'api:system:lldap:credentials:post', status: 500 });
  }
}

/**
 * Forget stored LLDAP credentials. Uses saveConfig directly because
 * updateConfig deep-merges and cannot delete keys.
 */
export async function DELETE() {
  const config = await getConfig();
  const next = { ...config };
  delete next.lldap;
  await saveConfig(next);
  return NextResponse.json({ ok: true });
}
