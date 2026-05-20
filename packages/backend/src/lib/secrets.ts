// src/lib/secrets.ts
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './dirs';

const SECRET_KEY_PATH = path.join(DATA_DIR, 'secret.key');
const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:';

// Ensure secret key exists
function getSecretKey(): Buffer {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(SECRET_KEY_PATH)) {
    const key = crypto.randomBytes(32); // 256 bits
    fs.writeFileSync(SECRET_KEY_PATH, key, { mode: 0o600 });
    return key;
  }

  return fs.readFileSync(SECRET_KEY_PATH);
}

// Global cached key (loaded on first use)
let CACHED_KEY: Buffer | null = null;

function getKey(): Buffer {
  if (!CACHED_KEY) {
    CACHED_KEY = getSecretKey();
  }
  return CACHED_KEY;
}

/**
 * Encrypts a plain text string.
 * Format: enc:v1:IV:AUTH_TAG:CIPHERTEXT
 */
export function encrypt(text: string): string {
  if (!text) return text;
  // If already encrypted, skip
  if (text.startsWith(PREFIX)) return text;

  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  const ivHex = iv.toString('hex');

  return `${PREFIX}v1:${ivHex}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a cipher text string.
 * Expects format: enc:v1:IV:AUTH_TAG:CIPHERTEXT
 */
export function decrypt(text: string): string {
  if (!text) return text;
  if (!text.startsWith(PREFIX)) return text; // Not encrypted

  try {
    const parts = text.split(':');
    if (parts.length !== 5) return text; // Invalid format
    
    // parts[0] = enc
    // parts[1] = v1
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encrypted = parts[4];
    
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (e) {
    console.error('Failed to decrypt secret:', e);
    return text; // Fallback to raw (though usually useless if encrypted)
  }
}
