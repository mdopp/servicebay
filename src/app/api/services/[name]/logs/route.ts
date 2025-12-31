import { NextResponse } from 'next/server';
import { getServiceLogs, getPodmanLogs, getPodmanPs } from '@/lib/manager';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  
  const [serviceLogs, podmanLogs, podmanPs] = await Promise.all([
    getServiceLogs(name),
    getPodmanLogs(),
    getPodmanPs()
  ]);

  return NextResponse.json({
    serviceLogs,
    podmanLogs,
    podmanPs
  });
}
