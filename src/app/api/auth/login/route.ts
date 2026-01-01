import { NextRequest, NextResponse } from 'next/server';
import { login } from '@/lib/auth';
import os from 'os';
import * as pty from 'node-pty';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { username, password } = body;

    if (!username || !password) {
      return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
    }

    const currentUser = os.userInfo().username;

    // Security: Only allow login as the user running the service
    if (username !== currentUser) {
      return NextResponse.json({ error: `Only the system user '${currentUser}' can log in.` }, { status: 403 });
    }

    // Verify password using 'su'
    const isAuthenticated = await verifyUserPassword(username, password);

    if (isAuthenticated) {
      await login(username);
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function verifyUserPassword(username: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    // We use 'su' to verify the password.
    // command: su <username> -c "echo AUTH_SUCCESS"
    // It will prompt for password.
    
    const shell = 'su';
    const args = [username, '-c', 'echo AUTH_SUCCESS'];

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: process.env as any
    });

    let output = '';
    let isResolved = false;

    ptyProcess.onData((data) => {
      output += data;
      console.log('[Auth Debug] PTY Output:', JSON.stringify(data));
      
      // Look for password prompt
      // Different distros have different prompts, usually "Password:" or "Password for user:"
      // Also handle German "Passwort:"
      if (data.includes('assword:') || data.includes('assword') || data.includes('asswort:') || data.includes('asswort')) {
        ptyProcess.write(password + '\n');
      }

      if (output.includes('AUTH_SUCCESS')) {
        if (!isResolved) {
            isResolved = true;
            resolve(true);
            ptyProcess.kill();
        }
      }
      
      if (output.includes('Authentication failure') || output.includes('incorrect password')) {
         if (!isResolved) {
            isResolved = true;
            resolve(false);
            ptyProcess.kill();
         }
      }
    });

    ptyProcess.onExit(() => {
      if (!isResolved) {
        // If we exit with 0, it might be success, but we rely on the echo
        // If we exit with 1, it's definitely failure
        // However, checking the output string is safer for auth
        resolve(output.includes('AUTH_SUCCESS'));
      }
    });

    // Timeout safety
    setTimeout(() => {
        if (!isResolved) {
            isResolved = true;
            resolve(false);
            ptyProcess.kill();
        }
    }, 5000);
  });
}
