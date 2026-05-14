import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { setSambaPassword } from '@/lib/fileShare/sambaSync';

export const dynamic = 'force-dynamic';

const SAFE_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * POST /api/system/file-share/samba/users/[id]/set-password
 *
 * Body:
 *   - omitted or `{}` → generate a fresh random password (returned in
 *     the response so the UI can flash it once for the operator to
 *     copy + share with the user).
 *   - `{ "password": "..." }` → set the given value verbatim.
 *
 * The route runs `smbpasswd -s -a <user>` inside the file-share-samba
 * container via the agent. Reads the LLDAP user list to validate the
 * id, so unknown users are rejected with 404 rather than silently
 * adding a Samba-only account.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const { id } = await params;
    if (!SAFE_USERNAME.test(id)) {
      return NextResponse.json({ error: 'Invalid username.' }, { status: 400 });
    }

    let body: { password?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      // Empty body = generate random. Don't 400 on missing JSON.
    }
    const password = typeof body.password === 'string' && body.password.length >= 8
      ? body.password
      : undefined;

    const result = await setSambaPassword(id, password ? { password } : {});
    if (!result.ok) {
      const status = result.reason === 'not_in_lldap' ? 404 : 500;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error, { tag: 'api:system:file-share:samba:set-password', status: 500 });
  }
}
