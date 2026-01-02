
import { SignJWT } from 'jose';

const SECRET_KEY = 'servicebay-insecure-fallback-secret-key-change-me';
const key = new TextEncoder().encode(SECRET_KEY);

async function generate() {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const session = await new SignJWT({ user: 'mdopp', expires })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(key);
  console.log(session);
}

generate();
