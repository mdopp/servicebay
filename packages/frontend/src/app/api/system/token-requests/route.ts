import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { listTokenRequests, type TokenRequestStatus } from '@/lib/auth/tokenRequests';

// Admin view over the MCP scoped-token request queue (#2139). The MCP
// request_token / poll_token_request tools file and collect; this route is
// the admin surface that lists them (approve/deny live in `[id]/route.ts`).
// Secrets are never returned — listTokenRequests strips them.
export const dynamic = 'force-dynamic';

const ListQuery = z.object({
  status: z.enum(['pending', 'approved', 'denied', 'all']).optional(),
});

export const GET = withApiHandler<undefined, z.infer<typeof ListQuery>>(
  { query: ListQuery },
  async ({ query }) => {
    const requests = await listTokenRequests(query?.status as TokenRequestStatus | 'all' | undefined);
    return { requests };
  },
);
