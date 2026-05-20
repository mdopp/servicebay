import { scrypt, randomBytes, timingSafeEqual } from 'crypto';

function scryptAsync(password: string, salt: Buffer, keylen: number, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: cost }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

const N = 16384;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const PREFIX = 'scrypt';

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plain, salt, HASH_BYTES, N);
  return `${PREFIX}$${N}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  if (typeof plain !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 1024 || cost > 1 << 20) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2], 'base64');
    expected = Buffer.from(parts[3], 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const derived = await scryptAsync(plain, salt, expected.length, cost);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function isPasswordHash(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('$');
  return parts.length === 4 && parts[0] === PREFIX;
}
