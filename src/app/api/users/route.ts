import { NextRequest, NextResponse } from 'next/server';
import { getLldapClientFromConfig } from '@/lib/lldap';

export async function GET() {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }
    const users = await client.listUsers();
    return NextResponse.json(users);
  } catch (error) {
    console.error('Failed to list users:', error);
    return NextResponse.json({ error: 'Failed to list users' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }

    const body = await request.json();
    const { id, email, displayName, firstName, lastName, groups } = body;

    if (!id || !email) {
      return NextResponse.json({ error: 'id and email are required' }, { status: 400 });
    }

    const user = await client.createUser({ id, email, displayName, firstName, lastName });

    // Add user to specified groups
    if (Array.isArray(groups)) {
      for (const groupId of groups) {
        await client.addUserToGroup(user.id, groupId);
      }
    }

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    console.error('Failed to create user:', error);
    const message = error instanceof Error ? error.message : 'Failed to create user';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }

    const { userId } = await request.json();
    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    await client.deleteUser(userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete user:', error);
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
