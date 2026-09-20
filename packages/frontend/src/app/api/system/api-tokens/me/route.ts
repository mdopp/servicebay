import { withApiHandler } from '@/lib/api/handler';
import { whoamiHandler } from '@/lib/api/apiTokenRoutes';

export const dynamic = 'force-dynamic';

// `skipAuth` for the same reason as ../delegate (#2048): the Bearer presented IS
// the credential, verified by `verifyToken` inside the handler, and there is no
// scope to hold — a token of any scope may ask what it is (#2984). Returns
// id/name/scopes/parent/expiry only: never the hash, never the prefix.
export const GET = withApiHandler({ skipAuth: true }, whoamiHandler);
