import { NextResponse } from 'next/server';
import { getServiceFiles, deleteService, saveService } from '@/lib/manager';

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const { name } = await params;
    const files = await getServiceFiles(name);
    return NextResponse.json(files);
  } catch (e) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  await deleteService(name);
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await request.json();
  const { kubeContent, yamlContent, yamlFileName } = body;
   
  await saveService(name, kubeContent, yamlContent, yamlFileName);
  return NextResponse.json({ success: true });
}
