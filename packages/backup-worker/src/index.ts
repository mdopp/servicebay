// @servicebay/backup-worker — public surface.
//
// The config-staging engine (walk/select/strip/transform/copy/tar) + the manifest
// + the compact status-file contract shared with servicebay. The heavy path runs
// in this package's OWN capped container (src/cli/main.ts); servicebay imports the
// manifest + the status contract from here and reads the worker's status.json via
// the contract (./contract — re-exported below).
//
// Second application of #1949: heavy jobs live in a resource-capped worker, the
// control plane stays thin (feedback_control_plane_vs_worker).

// --- Engine + manifest ---
export * from './engine/serviceManifest';
export * from './engine/staging';

// --- Status-file contract (shared with servicebay) ---
export * from './contract/status';
