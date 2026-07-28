import fs from 'fs/promises';
import fsSync from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

/** Temp-file name used by both variants: same directory as the target (so the
 *  rename is a same-filesystem, atomic operation), hidden, pid+random-suffixed
 *  so two concurrent writers never collide on it. */
function tmpPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = randomBytes(6).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${suffix}.tmp`);
}

/**
 * Atomically write a file: write to a temp file in the same directory, fsync,
 * then rename onto the target path. A crash mid-write leaves the original file
 * untouched (rather than truncated/half-written).
 */
export async function atomicWriteFile(filePath: string, data: string | Buffer, encoding: BufferEncoding = 'utf-8'): Promise<void> {
  const tmp = tmpPathFor(filePath);

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

/**
 * Synchronous twin of {@link atomicWriteFile} — same tmp → fsync → rename
 * contract. Exists because some durable-state stores (e.g. `health/store.ts`)
 * expose a sync public API that dozens of call sites across the MCP, portal
 * and service-lifecycle bundles depend on; they still must not truncate the
 * operator's data on a crash mid-write.
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer, encoding: BufferEncoding = 'utf-8'): void {
  const tmp = tmpPathFor(filePath);

  let fd: number | undefined;
  try {
    fd = fsSync.openSync(tmp, 'w', 0o600);
    fsSync.writeFileSync(fd, data, typeof data === 'string' ? { encoding } : {});
    fsSync.fsyncSync(fd);
    fsSync.closeSync(fd);
    fd = undefined;
    fsSync.renameSync(tmp, filePath);
  } catch (e) {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch { /* already closed */ }
    }
    try { fsSync.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}
