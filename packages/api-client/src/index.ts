// Public surface of @servicebay/api-client.
//
// The frontend imports types + the typed fetch helper from this
// package. The backend (route handlers) imports the same zod schemas
// so the contract is enforced from both sides.
//
// Phase 3.1 of the FE/BE separation (#762) extracted this from
// src/contracts/. Today the agent + install modules re-export type
// definitions from `@/lib/*`; later phases hoist the canonical
// definitions in-place so the package is structurally independent.

export * from './agent';
export * from './install';
export * from './services';
export * from './client';
