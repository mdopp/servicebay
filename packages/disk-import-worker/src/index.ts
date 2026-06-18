// @servicebay/disk-import-worker — public surface.
//
// The deterministic disk-import engine (walk/hash/classify/dedup/plan/apply) plus
// the compact status-file contract shared with servicebay. The heavy path runs in
// this package's OWN capped container (src/cli/main.ts); servicebay imports the
// engine types/glue from here and reads the worker's status.json/plan sidecar via
// the contract (./contract — re-exported below).
//
// Foundational slice of #1949: heavy jobs live in a resource-capped worker, the
// control plane stays thin (feedback_control_plane_vs_worker).

// --- Engine ---
export * from './engine/types';
export * from './engine/catalog';
export * from './engine/categories';
export * from './engine/classify';
export * from './engine/dedup';
export * from './engine/hostExec';
export * from './engine/hostScan';
export * from './engine/inventory';
export * from './engine/mounter';
export * from './engine/ollama';
export * from './engine/plan';
export * from './engine/routing';
export * from './engine/suggest';

// --- Status-file contract (shared with servicebay) ---
export * from './contract/status';
export * from './contract/lazyTree';
