import crypto from 'crypto';

interface DigestAuthOptions {
  username?: string;
  password?: string;
}

export async function fetchWithDigest(url: string, options: RequestInit, auth: DigestAuthOptions): Promise<Response> {
  // First request (will likely fail with 401)
  const firstRes = await fetch(url, options);

  if (firstRes.status !== 401) {
    return firstRes;
  }

  const authHeader = firstRes.headers.get('www-authenticate');
  if (!authHeader || !authHeader.startsWith('Digest')) {
    return firstRes;
  }

  // Parse challenge
  const challenge: Record<string, string> = {};
  authHeader.substring(7).split(',').forEach(part => {
    const [key, value] = part.trim().split('=');
    if (key && value) {
      challenge[key] = value.replace(/"/g, '');
    }
  });

  if (!challenge.realm || !challenge.nonce) {
    return firstRes;
  }

  // Generate response
  const ha1 = crypto.createHash('md5').update(`${auth.username}:${challenge.realm}:${auth.password}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${options.method || 'GET'}:${url}`).digest('hex');

  let response: string;
  let authHeaderValue: string;

  if (challenge.qop) {
      const nc = '00000001';
      const cnonce = crypto.randomBytes(8).toString('hex');
      response = crypto.createHash('md5').update(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`).digest('hex');
      authHeaderValue = `Digest username="${auth.username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${url}", qop=${challenge.qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
      response = crypto.createHash('md5').update(`${ha1}:${challenge.nonce}:${ha2}`).digest('hex');
      authHeaderValue = `Digest username="${auth.username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${url}", response="${response}"`;
  }

  // Second request with auth
  const newOptions = {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': authHeaderValue
    }
  };

  return fetch(url, newOptions);
}