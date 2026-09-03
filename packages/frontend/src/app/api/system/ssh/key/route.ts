import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'node:child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { SSH_DIR } from '@/lib/dirs';
import type { SshGenerateKeyResultSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

const execAsync = promisify(exec);

/**
 * POST /api/system/ssh/key — create the managed key pair if it is missing
 * (#2745, was `app/actions/ssh.ts:generateLocalKey`). Idempotent: an existing
 * key is left alone so re-running the wizard never rotates a key that remote
 * hosts already trust.
 */
export const POST = withApiHandler(
  {},
  async (): Promise<z.infer<typeof SshGenerateKeyResultSchema>> => {
    try {
      const keyPath = path.join(SSH_DIR, 'id_rsa');
      if (fs.existsSync(keyPath)) return { success: true, message: 'Key already exists' };

      if (!fs.existsSync(SSH_DIR)) fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
      await execAsync(`ssh-keygen -t rsa -b 4096 -f "${keyPath}" -N ""`);
      return { success: true, message: 'Key generated' };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
);
