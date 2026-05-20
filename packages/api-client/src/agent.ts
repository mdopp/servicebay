// Agent / digital-twin types shared between the frontend and the
// backend. The frontend imports the types it needs from here instead
// of reaching into `@/lib/agent/*`; the `sb/no-fe-backend-import` rule
// enforces that direction.
//
// Today these re-export from `@/lib/agent/types`. Phase 2 of the
// FE/BE separation (#753) hoists the canonical definitions into
// `@/contracts` and inverts the import direction.

export type { EnrichedContainer, PortMapping, ServiceUnit } from '@/lib/agent/types';
