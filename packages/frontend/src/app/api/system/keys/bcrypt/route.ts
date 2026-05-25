import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Body = z.object({ password: z.string().min(1) });

/**
 * Hash a password with bcrypt (cost factor 10). Used by the install
 * wizard to pre-seed AdGuardHome's user list — AdGuard accepts
 * `$2a$...` / `$2b$...` hashes in its YAML config so we can skip its
 * first-boot setup wizard entirely.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body },
  async ({ body }) => {
    try {
      const hash = await bcrypt.hash(body.password, 10);
      return NextResponse.json({ hash });
    } catch (error) {
      return apiError(error, { tag: 'api:system:keys:bcrypt', status: 500 });
    }
  },
);
