import { NextResponse } from 'next/server';
import { listServices, saveService } from '@/lib/manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  const services = await listServices();
  return NextResponse.json(services);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, kubeContent, yamlContent, yamlFileName } = body;
  
  if (!name || !kubeContent || !yamlContent || !yamlFileName) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  await saveService(name, kubeContent, yamlContent, yamlFileName);
  return NextResponse.json({ success: true });
}
