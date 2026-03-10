import { NextRequest, NextResponse } from 'next/server';
import { getLldapClientFromConfig } from '@/lib/lldap';

export async function GET() {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }
    const groups = await client.listGroups();
    return NextResponse.json(groups);
  } catch (error) {
    console.error('Failed to list groups:', error);
    return NextResponse.json({ error: 'Failed to list groups' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }

    const { name } = await request.json();
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const group = await client.createGroup(name);
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    console.error('Failed to create group:', error);
    const message = error instanceof Error ? error.message : 'Failed to create group';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }

    const { groupId } = await request.json();
    if (typeof groupId !== 'number') {
      return NextResponse.json({ error: 'groupId (number) is required' }, { status: 400 });
    }

    await client.deleteGroup(groupId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete group:', error);
    return NextResponse.json({ error: 'Failed to delete group' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }

    const { action, userId, groupId } = await request.json();

    if (!userId || typeof groupId !== 'number') {
      return NextResponse.json({ error: 'userId and groupId are required' }, { status: 400 });
    }

    if (action === 'add') {
      await client.addUserToGroup(userId, groupId);
    } else if (action === 'remove') {
      await client.removeUserFromGroup(userId, groupId);
    } else {
      return NextResponse.json({ error: 'action must be "add" or "remove"' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to update group membership:', error);
    return NextResponse.json({ error: 'Failed to update group membership' }, { status: 500 });
  }
}
