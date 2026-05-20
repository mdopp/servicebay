import fs from 'fs/promises';
import { randomBytes } from 'crypto';
import path from 'path';

/**
 * Atomically write a file: write to a temp file in the same directory, fsync,
 * then rename onto the target path. A crash mid-write leaves the original file
 * untouched (rather than truncated/half-written).
 */
export async function atomicWriteFile(filePath: string, data: string | Buffer, encoding: BufferEncoding = 'utf-8'): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = randomBytes(6).toString('hex');
  const tmp = path.join(dir, `.${base}.${process.pid}.${suffix}.tmp`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'w', 0o600);
    if (typeof data === 'string') {
      await handle.writeFile(data, { encoding });
    } else {
      await handle.writeFile(data);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, filePath);
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}
