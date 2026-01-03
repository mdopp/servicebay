import { NextResponse } from 'next/server';
import { NetworkStore } from '@/lib/network/store';
import crypto from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { source, target, port } = body;

    if (!source || !target) {
      return NextResponse.json({ error: 'Missing source or target' }, { status: 400 });
    }

    const edge = {
      id: `manual-${crypto.randomUUID()}`,
      source,
      target,
      label: port ? `:${port} (manual)` : 'Manual Link',
      port: port ? parseInt(port) : undefined,
      created_at: new Date().toISOString()
    };

    await NetworkStore.addEdge(edge);
    return NextResponse.json(edge);
  } catch (e) {
    console.error('Failed to add edge', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    await NetworkStore.removeEdge(id);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('Failed to remove edge', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}