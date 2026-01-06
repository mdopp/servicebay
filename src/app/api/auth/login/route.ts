import { NextRequest, NextResponse } from 'next/server';
import { login } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    // AUTH MODE: Unified Config-based Auth
    // Whether running in container or locally, we rely on the configuration.
    // This ensures consistency across environments.
    const config = await getConfig();
    const configPassword = config.auth?.password || process.env.SERVICEBAY_PASSWORD;
    const configUsername = config.auth?.username || process.env.SERVICEBAY_USERNAME || 'admin';

    // If no password is configured, we cannot authenticate securely.
    if (!configPassword) {
        return NextResponse.json({ 
            error: 'Authentication not configured. Please set a password in your configuration or SERVICEBAY_PASSWORD environment variable.' 
        }, { status: 503 });
    }

    if (username === configUsername && password === configPassword) {
         await login(username);
         return NextResponse.json({ success: true });
    } else {
         return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
