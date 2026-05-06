import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';

export const dynamic = 'force-dynamic';

/**
 * Hash a password with bcrypt (cost factor 10). Used by the install wizard
 * to pre-seed AdGuardHome's user list — AdGuard accepts `$2a$...` / `$2b$...`
 * hashes in its YAML config so we can skip its first-boot setup wizard
 * entirely.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { password } = body as { password?: string };
    if (typeof password !== 'string' || !password) {
      return NextResponse.json({ error: 'password is required' }, { status: 400 });
    }
    const hash = await bcrypt.hash(password, 10);
    return NextResponse.json({ hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'hash failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
