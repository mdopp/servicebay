import { NextResponse } from 'next/server';
import { readRecentAudit } from '@/lib/mcp/audit';
import { requireSession } from '@/lib/api/requireSession';

export const dynamic = 'force-dynamic';

/**
 * Read recent MCP audit entries. Limited to the most recent 500 entries
 * to keep payloads bounded — operators wanting deeper history can read
 * `mcp-audit.log` directly off the host (also captured by system backups).
 */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const entries = await readRecentAudit(Number.isFinite(limit) ? limit : 100);
  return NextResponse.json({ entries });
}
