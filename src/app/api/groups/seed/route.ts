import { NextResponse } from 'next/server';
import { getLldapClientFromConfig } from '@/lib/lldap';

export async function POST() {
  try {
    const client = await getLldapClientFromConfig();
    if (!client) {
      return NextResponse.json({ error: 'LDAP not configured' }, { status: 503 });
    }

    const created = await client.seedDefaultGroups();

    return NextResponse.json({
      success: true,
      created,
      message: created.length > 0
        ? `Created groups: ${created.join(', ')}`
        : 'All default groups already exist',
    });
  } catch (error) {
    console.error('Failed to seed groups:', error);
    return NextResponse.json({ error: 'Failed to seed default groups' }, { status: 500 });
  }
}
